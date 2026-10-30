RUNTIMES = docker-compose -f generated/docker-compose.runtimes.yml

%:
	@:

up:
	docker-compose run --rm sites
	docker-compose up -d nginx dns
	$(RUNTIMES) up -d --remove-orphans

down:
	-$(RUNTIMES) down
	docker-compose stop nginx dns

reload: up
	docker-compose restart dns
	docker-compose exec nginx nginx -s reload
	@nodes="$$(sed -n 's/^  \(node[0-9.]*\):$$/\1/p' generated/docker-compose.runtimes.yml)"; \
	[ -z "$$nodes" ] || $(RUNTIMES) restart $$nodes

build:
	docker-compose run --rm sites
	$(RUNTIMES) build $(filter-out $@,$(MAKECMDGOALS))

up-%:
	docker-compose -f docker-compose.yml -f docker-compose.$*.yml up -d $(filter-out $@,$(MAKECMDGOALS))

down-%:
	docker-compose -f docker-compose.yml -f docker-compose.$*.yml down $(filter-out $@,$(MAKECMDGOALS))

restart-%:
	docker-compose -f docker-compose.yml -f docker-compose.$*.yml restart $(filter-out $@,$(MAKECMDGOALS))
