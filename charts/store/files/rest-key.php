<?php
/**
 * Stores the woo-mcp REST key from the environment the way WooCommerce stores keys it generates
 * (an HMAC of the consumer key, the secret, and the last seven characters), so no one copies a key
 * out of wp-admin. Run with --user set to the admin; the key acts as that user. Updates the row
 * when the Secret changes.
 */

global $wpdb;

$consumer_key    = getenv( 'WC_CONSUMER_KEY' );
$consumer_secret = getenv( 'WC_CONSUMER_SECRET' );
$description     = 'woo-mcp (managed by the store chart)';
$table           = $wpdb->prefix . 'woocommerce_api_keys';

$row = array(
	'user_id'         => get_current_user_id(),
	'description'     => $description,
	'permissions'     => 'read_write',
	'consumer_key'    => wc_api_hash( $consumer_key ),
	'consumer_secret' => $consumer_secret,
	'truncated_key'   => substr( $consumer_key, -7 ),
);

$key_id = $wpdb->get_var( $wpdb->prepare( "SELECT key_id FROM {$table} WHERE description = %s", $description ) );
$result = $key_id ? $wpdb->update( $table, $row, array( 'key_id' => $key_id ) ) : $wpdb->insert( $table, $row );
if ( false === $result ) {
	WP_CLI::error( 'Could not store the woo-mcp REST key: ' . $wpdb->last_error );
}
WP_CLI::success( 'The woo-mcp REST key is in place.' );
