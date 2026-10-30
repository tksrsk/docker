const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const WORK_DIR = '/work';
const SITES_FILE = path.join(WORK_DIR, 'sites.yml');
const OUT_DIR = '/generated';
const { NGINX_IP, DNS_IP } = process.env;
const NODE_PORT_BASE = 3000;

function fail(message) {
  console.error(`sites.yml: ${message}`);
  process.exit(1);
}

if (!fs.statSync(SITES_FILE, { throwIfNoEntry: false })?.isFile()) {
  fail('ファイルがありません (cp sites.example.yml sites.yml で作成してください)');
}

let sites;
try {
  sites = yaml.load(fs.readFileSync(SITES_FILE, 'utf8')) ?? {};
} catch (e) {
  fail(e.message);
}

function expandEnv(where, env = {}) {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => {
    const expanded = String(value ?? '').replace(/\$\{(\w+)\}/g, (_, name) => {
      if (process.env[name] === undefined) console.warn(`warning: ${where}: \${${name}} が .env にありません`);
      return process.env[name] ?? '';
    });
    return [key, expanded];
  }));
}

function parseRuntime(runtime) {
  if (runtime === 'static') return { kind: 'static' };
  const m = runtime.match(/^(php|node)(\d+(?:\.\d+)*)$/);
  if (!m) fail(`${runtime}: 未対応のランタイムです (static, php<バージョン>, node<バージョン>)`);
  return { kind: m[1], version: m[2] };
}

const entries = Object.entries(sites).flatMap(([runtime, roots]) => {
  if (!roots || typeof roots !== 'object' || Array.isArray(roots)) {
    fail(`${runtime}: 「ルートのパス: 設定」の形で書いてください`);
  }
  return Object.entries(roots).flatMap(([root, site]) =>
    [].concat(site ?? {}).map((s) => ({ runtime, root, ...s })));
});

const servers = [];
const dns = [];
const nodeApps = {};
const runtimes = new Map();
const domainOwner = new Map();

const indent = (text) => text.trim().split('\n').map((l) => (l ? `    ${l}` : l)).join('\n');

for (const site of entries) {
  if (site.disabled) continue;

  const { runtime, domains, root } = site;
  const where = `${runtime} ${root}`;
  if (!domains?.length) fail(`${where}: domains は必須です`);

  const { kind, version } = parseRuntime(runtime);
  if (kind !== 'static') runtimes.set(runtime, { kind, version });

  for (const domain of domains) {
    if (domainOwner.has(domain)) fail(`${where}: ${domain} は ${domainOwner.get(domain)} と重複しています`);
    domainOwner.set(domain, where);
    dns.push(`address=/${domain}/${NGINX_IP}`);
  }

  const env = expandEnv(where, site.env);
  const body = [];

  if (kind === 'static') {
    body.push(`set $__index ${site.index ?? 'index.html'};`, 'include /etc/nginx/snippets/static.conf;');
  } else if (kind === 'php') {
    const params = Object.entries(env).map(([key, value]) => {
      if (/["\\$]/.test(value)) fail(`${where}: env.${key} に " \\ $ は使えません`);
      return `fastcgi_param ${key} "${value}";`;
    });
    body.push(
      `set $php ${runtime};`,
      'include /etc/nginx/snippets/php.conf;',
      '',
      'location ~ \\.php$ {',
      '    include /etc/nginx/snippets/fastcgi.conf;',
      ...params.map((p) => `    ${p}`),
      '}',
    );
  } else {
    if (!site.start) fail(`${where}: node の場合は start (起動コマンド) が必須です`);
    const apps = (nodeApps[runtime] ??= []);
    const port = NODE_PORT_BASE + apps.length;
    apps.push({
      name: domains[0],
      cwd: root,
      script: '/bin/sh',
      args: ['-c', `exec ${site.start}`],
      interpreter: 'none',
      env: { ...env, PORT: port },
      exp_backoff_restart_delay: 1000,
    });
    body.push(`set $node ${runtime};`, `set $port ${port};`, 'include /etc/nginx/snippets/node.conf;');
  }

  const serverName = `server_name ${domains.join(' ')};`;
  if (site.force_https) {
    servers.push(`server {\n    listen 80;\n    ${serverName}\n    return 301 https://$host$request_uri;\n}`);
  }
  servers.push([
    `# ${where}`,
    'server {',
    ...(site.force_https ? [] : ['    listen 80;']),
    '    listen 443 ssl;',
    `    ${serverName}`,
    `    root ${root};`,
    '',
    indent(body.join('\n')),
    ...(site.nginx ? ['', indent(site.nginx)] : []),
    '}',
  ].join('\n'));
}

// settings/ 以下のファイルを同じパスでマウントする
function settingFiles(dir = path.join(WORK_DIR, 'settings')) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return settingFiles(full);
    return e.name === '.gitignore' ? [] : [path.relative(path.join(WORK_DIR, 'settings'), full)];
  });
}
const settings = settingFiles().sort().map((f) => `../settings/${f}:/${f}:ro`);

// パスは generated/ からの相対パス
const services = {};
for (const [runtime, { kind, version }] of [...runtimes].sort()) {
  const common = { dns: DNS_IP, volumes: ['project:/project', ...settings] };
  if (kind === 'php') {
    services[runtime] = {
      build: { context: '../php', args: { PHP_VERSION: version } },
      image: `local-php:${version}`,
      ...common,
    };
  } else {
    services[runtime] = {
      build: { context: '../node', args: { NODE_VERSION: version } },
      image: `local-node:${version}`,
      init: true,
      environment: [`NODE_RUNTIME=${runtime}`],
      ...common,
      volumes: [...common.volumes, './:/generated:ro'],
    };
  }
}
const compose = {
  name: 'docker-runtimes',
  services,
  networks: { default: { name: 'docker_default', external: true } },
  volumes: { project: { external: true } },
};

for (const dir of ['nginx', 'node', 'dns']) {
  fs.rmSync(path.join(OUT_DIR, dir), { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT_DIR, dir), { recursive: true });
}
fs.writeFileSync(path.join(OUT_DIR, 'docker-compose.runtimes.yml'),
  `# sites.yml から生成 (直接編集しない)\n${yaml.dump(compose, { lineWidth: -1, noRefs: true })}`);
fs.writeFileSync(path.join(OUT_DIR, 'nginx/sites.conf'), `${servers.join('\n\n')}\n`);
fs.writeFileSync(path.join(OUT_DIR, 'dns/sites.conf'), `${dns.join('\n')}\n`);
for (const [runtime, apps] of Object.entries(nodeApps)) {
  fs.writeFileSync(path.join(OUT_DIR, `node/${runtime}.json`), JSON.stringify({ apps }, null, 2));
}

console.log(`generated ${domainOwner.size} domains, runtimes: ${[...runtimes.keys()].sort().join(', ') || '-'}`);
for (const [runtime, apps] of Object.entries(nodeApps)) {
  console.log(`  ${runtime}: ${apps.map((a) => `${a.name}:${a.env.PORT}`).join(', ')}`);
}
