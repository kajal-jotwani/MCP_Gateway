#!/bin/sh
# Brings the store to a known state: WordPress installed, WooCommerce at the pinned version, store
# settings, cash on delivery, the woo-mcp REST key and two sample products. Every step checks
# before it acts or is safe to repeat, so the Job runs on every install and upgrade.
set -eu
cd /var/www/html

until php -r 'try { mysqli_connect(getenv("WORDPRESS_DB_HOST"), getenv("WORDPRESS_DB_USER"), getenv("WORDPRESS_DB_PASSWORD"), getenv("WORDPRESS_DB_NAME")); } catch (Throwable $e) { exit(1); }'; do
  echo "waiting for the database"
  sleep 3
done

if ! wp core is-installed 2>/dev/null; then
  wp core install --url="$STORE_URL" --title="$STORE_TITLE" --admin_user="$WP_ADMIN_USER" \
    --admin_password="$WP_ADMIN_PASSWORD" --admin_email="$WP_ADMIN_EMAIL" --skip-email
fi
wp option update timezone_string "$STORE_TIMEZONE"
# Pretty permalinks, so the REST API is served under /wp-json/.
wp rewrite structure '/%postname%/'

if [ "$(wp plugin get woocommerce --field=version 2>/dev/null || true)" != "$WOOCOMMERCE_VERSION" ]; then
  wp plugin install woocommerce --version="$WOOCOMMERCE_VERSION" --force
fi
wp plugin is-active woocommerce || wp plugin activate woocommerce
wp wc update
wp wc tool run install_pages --user="$WP_ADMIN_USER"

wp option update woocommerce_currency "$STORE_CURRENCY"
wp option update woocommerce_default_country "$STORE_COUNTRY"
# New stores start in "coming soon" mode, which hides the storefront from visitors.
wp option update woocommerce_coming_soon no
# Without shipping zones, checkout fails for physical products. Shipping is not part of this store.
wp option update woocommerce_ship_to_countries disabled
if ! wp wc payment_gateway get cod --fields=enabled --format=json --user="$WP_ADMIN_USER" | grep -q '"enabled":true'; then
  wp wc payment_gateway update cod --enabled=true --user="$WP_ADMIN_USER"
fi

wp eval-file /scripts/rest-key.php --user="$WP_ADMIN_USER"

if ! wp option get urumi_sample_products >/dev/null 2>&1; then
  wp wc product create --name='Coffee Mug' --regular_price=499 --user="$WP_ADMIN_USER" --porcelain
  wp wc product create --name='Cotton T-Shirt' --regular_price=899 --user="$WP_ADMIN_USER" --porcelain
  wp option add urumi_sample_products yes
fi
echo "store setup complete"
