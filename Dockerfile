# Imagen para Google Cloud Run: Apache + PHP 8.3 sirviendo la app y la API.
# La conexión a la base (Cloud SQL) se configura con variables de entorno y Secret Manager.
FROM mirror.gcr.io/library/php:8.3-apache

RUN docker-php-ext-install pdo_mysql \
 && a2enmod headers rewrite remoteip \
 && echo "expose_php = Off" > /usr/local/etc/php/conf.d/seguridad.ini \
 && echo "display_errors = Off" >> /usr/local/etc/php/conf.d/seguridad.ini \
 && echo "log_errors = On" >> /usr/local/etc/php/conf.d/seguridad.ini \
 && echo "session.cookie_httponly = 1" >> /usr/local/etc/php/conf.d/seguridad.ini

COPY servidor/apache.conf /etc/apache2/sites-available/000-default.conf
RUN sed -i 's/^ServerTokens .*/ServerTokens Prod/; s/^ServerSignature .*/ServerSignature Off/' /etc/apache2/conf-available/security.conf \
 && sed -i 's/Listen 80/Listen ${PORT}/' /etc/apache2/ports.conf

WORKDIR /var/www/app
COPY . /var/www/app
RUN rm -rf .git .github servidor/tests && chown -R www-data:www-data /var/www/app

ENV PORT=8080
EXPOSE 8080
