ARG NODE_VERSION
FROM node:${NODE_VERSION}

RUN npm install -g pm2

CMD ["sh", "-c", "f=/generated/node/$NODE_RUNTIME.json; if [ -f $f ]; then exec pm2-runtime $f; else echo \"no apps for $NODE_RUNTIME\"; exec tail -f /dev/null; fi"]
