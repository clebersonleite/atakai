<?php

/**
 * Plugin Name: Atakaí Dashboard
 * Description: Dashboard de monitoramento da integração Atakaí ↔ WooCommerce.
 * Version:     1.0.0
 * Author:      Atakaí
 * Requires at least: 6.0
 * Requires PHP: 8.0
 */

if (! defined('ABSPATH')) {
    exit;
}

// ─── Admin menu ───────────────────────────────────────────────────────────────

add_action('admin_menu', function () {
    add_menu_page(
        'Atakaí Dashboard',
        'Atakaí',
        'manage_options',
        'takai-dashboard',
        'takai_dashboard_page',
        'dashicons-chart-area',
        3
    );

    add_submenu_page(
        'takai-dashboard',
        'Dashboard',
        'Dashboard',
        'manage_options',
        'takai-dashboard',
        'takai_dashboard_page'
    );

    add_submenu_page(
        'takai-dashboard',
        'Configurações',
        'Configurações',
        'manage_options',
        'takai-settings',
        'takai_settings_page'
    );
});

// ─── Save settings ────────────────────────────────────────────────────────────

add_action('admin_post_takai_save_settings', function () {
    check_admin_referer('takai_save_settings');

    if (! current_user_can('manage_options')) {
        wp_die('Sem permissão.');
    }

    update_option('takai_api_url', sanitize_url($_POST['takai_api_url'] ?? ''));
    update_option('takai_api_key', sanitize_text_field($_POST['takai_api_key'] ?? ''));

    wp_redirect(admin_url('admin.php?page=takai-settings&saved=1'));
    exit;
});

// ─── Settings page ────────────────────────────────────────────────────────────

function takai_settings_page(): void
{
    $api_url = get_option('takai_api_url', '');
    $api_key = get_option('takai_api_key', '');
    $saved   = isset($_GET['saved']);
?>
    <div class="wrap">
        <h1>Atakaí — Configurações</h1>

        <?php if ($saved) : ?>
            <div class="notice notice-success is-dismissible">
                <p>Configurações salvas com sucesso!</p>
            </div>
        <?php endif; ?>

        <form method="post" action="<?= esc_url(admin_url('admin-post.php')) ?>">
            <?php wp_nonce_field('takai_save_settings'); ?>
            <input type="hidden" name="action" value="takai_save_settings">

            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row">
                        <label for="takai_api_url">URL da API</label>
                    </th>
                    <td>
                        <input type="url" id="takai_api_url" name="takai_api_url"
                            value="<?= esc_attr($api_url) ?>"
                            class="regular-text"
                            placeholder="https://api.seudominio.com">
                        <p class="description">Endereço base da takai-api (sem barra final).</p>
                    </td>
                </tr>
                <tr>
                    <th scope="row">
                        <label for="takai_api_key">API Key</label>
                    </th>
                    <td>
                        <input type="password" id="takai_api_key" name="takai_api_key"
                            value="<?= esc_attr($api_key) ?>"
                            class="regular-text">
                        <p class="description">Valor da variável de ambiente <code>SYNC_STATS_API_KEY</code> na API.</p>
                    </td>
                </tr>
            </table>

            <?php submit_button('Salvar configurações'); ?>
        </form>
    </div>
<?php
}

// ─── Fetch sync stats from NestJS API ─────────────────────────────────────────

function takai_get_sync_stats(): array
{
    $api_url = rtrim(get_option('takai_api_url', ''), '/');
    $api_key = get_option('takai_api_key', '');

    if (empty($api_url) || empty($api_key)) {
        return ['error' => 'API não configurada. Acesse Atakaí → Configurações.'];
    }

    $response = wp_remote_get("{$api_url}/sync/stats", [
        'timeout'   => 10,
        'headers'   => ['x-api-key' => $api_key],
        'sslverify' => true,
    ]);

    if (is_wp_error($response)) {
        return ['error' => 'Falha ao conectar com a API: ' . $response->get_error_message()];
    }

    $code = wp_remote_retrieve_response_code($response);
    if ($code !== 200) {
        return ['error' => "A API retornou HTTP {$code}. Verifique a URL e a API Key."];
    }

    $body = json_decode(wp_remote_retrieve_body($response), true);

    return is_array($body) ? $body : ['error' => 'Resposta inválida da API.'];
}

// ─── WooCommerce DB stats ─────────────────────────────────────────────────────

function takai_get_woo_stats(): array
{
    global $wpdb;

    // Total de produtos publicados
    $total_products = (int) $wpdb->get_var(
        "SELECT COUNT(*) FROM {$wpdb->posts}
         WHERE post_type = 'product' AND post_status = 'publish'"
    );

    // Total de clientes (role customer)
    $total_customers = (int) $wpdb->get_var($wpdb->prepare(
        "SELECT COUNT(*) FROM {$wpdb->usermeta}
         WHERE meta_key = %s AND meta_value LIKE %s",
        $wpdb->prefix . 'capabilities',
        '%customer%'
    ));

    // Total de pedidos (todos os status WC)
    $order_statuses = [
        'wc-pending',
        'wc-processing',
        'wc-on-hold',
        'wc-completed',
        'wc-cancelled',
        'wc-refunded',
        'wc-failed',
    ];

    $placeholders = implode(',', array_fill(0, count($order_statuses), '%s'));
    // phpcs:ignore WordPress.DB.PreparedSQLPlaceholders.UnfinishedPrepare
    $total_orders = (int) $wpdb->get_var($wpdb->prepare(
        "SELECT COUNT(*) FROM {$wpdb->posts}
         WHERE post_type = 'shop_order' AND post_status IN ({$placeholders})",
        $order_statuses
    ));

    // Pedidos por status
    $orders_by_status = [];
    foreach ($order_statuses as $status) {
        $count = (int) $wpdb->get_var($wpdb->prepare(
            "SELECT COUNT(*) FROM {$wpdb->posts}
             WHERE post_type = 'shop_order' AND post_status = %s",
            $status
        ));
        if ($count > 0) {
            $label                    = ucwords(str_replace(['wc-', '-'], ['', ' '], $status));
            $orders_by_status[$label] = $count;
        }
    }

    return compact('total_products', 'total_customers', 'total_orders', 'orders_by_status');
}

// ─── Dashboard page ───────────────────────────────────────────────────────────

function takai_dashboard_page(): void
{
    $sync  = takai_get_sync_stats();
    $woo   = takai_get_woo_stats();
    $error = $sync['error'] ?? null;

    // Formata data para fuso de São Paulo
    $last_sync = '—';
    if (! empty($sync['lastSync'])) {
        try {
            $dt        = new DateTime($sync['lastSync'], new DateTimeZone('UTC'));
            $dt->setTimezone(new DateTimeZone('America/Sao_Paulo'));
            $last_sync = $dt->format('d/m/Y H:i:s');
        } catch (Exception $e) {
            $last_sync = esc_html($sync['lastSync']);
        }
    }

    $duration = isset($sync['lastSyncDurationSeconds']) ? $sync['lastSyncDurationSeconds'] . 's' : '—';
    $created  = isset($sync['productsCreated'])  ? number_format((int) $sync['productsCreated'],  0, ',', '.') : '—';
    $updated  = isset($sync['productsUpdated'])  ? number_format((int) $sync['productsUpdated'],  0, ',', '.') : '—';
    $deleted  = isset($sync['productsDeleted'])  ? number_format((int) $sync['productsDeleted'],  0, ',', '.') : '—';
?>
    <div class="wrap">
        <h1 style="display:flex;align-items:center;gap:10px;">
            <span class="dashicons dashicons-chart-area"
                style="font-size:30px;width:30px;height:30px;color:#2271b1;margin-top:2px;"></span>
            Atakaí — Dashboard de Integração
        </h1>

        <?php if ($error) : ?>
            <div class="notice notice-error" style="margin-top:16px;">
                <p><strong>Atenção:</strong> <?= esc_html($error) ?></p>
            </div>
        <?php endif; ?>

        <!-- ── Última sincronização ──────────────────────── -->
        <h2 style="margin-top:28px;padding-bottom:8px;border-bottom:1px solid #dcdcde;">
            Última Sincronização
        </h2>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;">
            <?php takai_card('Realizada em', $last_sync, '#2271b1', 'dashicons-clock'); ?>
            <?php takai_card('Duração', $duration, '#135e96', 'dashicons-performance'); ?>
        </div>

        <!-- ── Produtos sincronizados ─────────────────────── -->
        <h2 style="margin-top:36px;padding-bottom:8px;border-bottom:1px solid #dcdcde;">
            Produtos — Última Sincronização
        </h2>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;">
            <?php takai_card('Criados', $created, '#00a32a', 'dashicons-plus-alt'); ?>
            <?php takai_card('Atualizados', $updated, '#dba617', 'dashicons-update'); ?>
            <?php takai_card('Removidos', $deleted, '#d63638', 'dashicons-trash'); ?>
        </div>

        <!-- ── WooCommerce ───────────────────────────────── -->
        <h2 style="margin-top:36px;padding-bottom:8px;border-bottom:1px solid #dcdcde;">
            WooCommerce
        </h2>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;">
            <?php takai_card('Produtos publicados', number_format($woo['total_products'], 0, ',', '.'), '#2271b1', 'dashicons-products'); ?>
            <?php takai_card('Clientes', number_format($woo['total_customers'], 0, ',', '.'), '#00a32a', 'dashicons-groups'); ?>
            <?php takai_card('Pedidos totais', number_format($woo['total_orders'], 0, ',', '.'), '#8c4f90', 'dashicons-cart'); ?>
        </div>

        <!-- ── Pedidos por status ─────────────────────────── -->
        <?php if (! empty($woo['orders_by_status'])) : ?>
            <h2 style="margin-top:36px;padding-bottom:8px;border-bottom:1px solid #dcdcde;">
                Pedidos por Status
            </h2>
            <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;">
                <?php
                $status_colors = [
                    'Processing' => '#dba617',
                    'Completed'  => '#00a32a',
                    'Pending'    => '#2271b1',
                    'On Hold'    => '#8c4f90',
                    'Cancelled'  => '#d63638',
                    'Refunded'   => '#646970',
                    'Failed'     => '#b32d2e',
                ];
                foreach ($woo['orders_by_status'] as $label => $count) :
                    $color = $status_colors[$label] ?? '#135e96';
                    takai_card($label, number_format($count, 0, ',', '.'), $color, 'dashicons-tag');
                endforeach;
                ?>
            </div>
        <?php endif; ?>

        <p style="margin-top:32px;color:#646970;font-size:13px;">
            <a href="<?= esc_url(admin_url('admin.php?page=takai-dashboard')) ?>">⟳ Atualizar dados</a>
            &nbsp;·&nbsp;
            <a href="<?= esc_url(admin_url('admin.php?page=takai-settings')) ?>">⚙ Configurações</a>
        </p>
    </div>
<?php
}

// ─── Card helper ──────────────────────────────────────────────────────────────

function takai_card(string $label, string $value, string $color, string $icon): void
{
?>
    <div style="background:#fff;border:1px solid #dcdcde;border-radius:8px;
                padding:20px 24px;min-width:160px;
                box-shadow:0 1px 3px rgba(0,0,0,.06);">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <span class="dashicons <?= esc_attr($icon) ?>"
                style="color:<?= esc_attr($color) ?>;font-size:20px;width:20px;height:20px;"></span>
            <span style="font-size:13px;color:#646970;"><?= esc_html($label) ?></span>
        </div>
        <div style="font-size:30px;font-weight:700;color:<?= esc_attr($color) ?>;">
            <?= esc_html($value) ?>
        </div>
    </div>
<?php
}
