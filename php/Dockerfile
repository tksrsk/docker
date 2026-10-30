ARG PHP_VERSION
FROM php:${PHP_VERSION}-fpm

ARG PHP_VERSION
ARG PKG_INSTALL_CMD='apt-get update && apt-get install -y --no-install-recommends'

ADD scripts /scripts
# externals/<バージョン>/ がなくても失敗しないよう .gitignore も含める
COPY externals/.gitignore externals/${PHP_VERSION}/* /externals/

RUN find /scripts -type f -exec sh {} \;
