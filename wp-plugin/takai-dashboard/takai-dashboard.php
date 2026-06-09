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

// ─── AJAX: forçar sincronização ───────────────────────────────────────────────

add_action('wp_ajax_takai_force_sync', function () {
    check_ajax_referer('takai_force_sync');

    if (! current_user_can('manage_options')) {
        wp_send_json_error(['message' => 'Sem permissão.'], 403);
    }

    $api_url = rtrim(get_option('takai_api_url', ''), '/');
    $api_key = get_option('takai_api_key', '');

    if (empty($api_url)) {
        wp_send_json_error(['message' => 'URL da API não configurada.']);
    }

    $response = wp_remote_get("{$api_url}/sync/all-products-from-apis", [
        'timeout'   => 600,
        'headers'   => ['x-api-key' => $api_key],
        'sslverify' => true,
    ]);

    if (is_wp_error($response)) {
        wp_send_json_error(['message' => 'Erro: ' . $response->get_error_message()]);
    }

    $code = wp_remote_retrieve_response_code($response);
    if ($code !== 200) {
        wp_send_json_error(['message' => "A API retornou HTTP {$code}."]);
    }

    wp_send_json_success(['message' => 'Sincronização concluída com sucesso!']);
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

        <!-- ── Logs de sincronização ────────────────── -->
        <h2 style="margin-top:36px;padding-bottom:8px;border-bottom:1px solid #dcdcde;">
            Logs
            <button id="takai-logs-refresh"
                style="margin-left:12px;font-size:12px;padding:4px 10px;
                           background:#f0f0f0;border:1px solid #c3c4c7;border-radius:3px;
                           cursor:pointer;vertical-align:middle;">
                &#x27F3; Atualizar
            </button>
        </h2>
        <div id="takai-logs-box"
            style="margin-top:12px;background:#1e1e1e;color:#d4d4d4;
                    border-radius:6px;padding:16px 18px;
                    font-family:'Courier New',Courier,monospace;font-size:13px;
                    line-height:1.6;max-height:420px;overflow-y:auto;">
            <span style="color:#646970;">Carregando logs...</span>
        </div>

        <!-- ── Botão forçar sincronização ────────────────── -->
        <h2 style="margin-top:36px;padding-bottom:8px;border-bottom:1px solid #dcdcde;">
            Sincronização Manual
        </h2>
        <div style="margin-top:16px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
            <button id="takai-sync-btn"
                style="display:inline-flex;align-items:center;gap:8px;
                           background:#2271b1;color:#fff;border:none;border-radius:4px;
                           padding:10px 20px;font-size:14px;font-weight:600;
                           cursor:pointer;transition:background .2s;">
                <span class="dashicons dashicons-update"
                    style="font-size:18px;width:18px;height:18px;margin-top:2px;"></span>
                Forçar Sincronização Agora
            </button>
            <span id="takai-sync-status" style="font-size:14px;"></span>
        </div>

        <p style="margin-top:32px;color:#646970;font-size:13px;">
            <a href="<?= esc_url(admin_url('admin.php?page=takai-dashboard')) ?>">&#x27F3; Atualizar dados</a>
            &nbsp;·&nbsp;
            <a href="<?= esc_url(admin_url('admin.php?page=takai-settings')) ?>">&#x2699; Configurações</a>
        </p>

        <style>
            @keyframes takai-spin {
                from {
                    transform: rotate(0deg);
                }

                to {
                    transform: rotate(360deg);
                }
            }
        </style>

        <script>
            // ── Logs ─────────────────────────────────────────────────────────
            (function() {
                const box = document.getElementById('takai-logs-box');
                const btnRef = document.getElementById('takai-logs-refresh');
                const nonce = '<?= esc_js(wp_create_nonce('takai_get_logs')) ?>';

                function levelColor(level) {
                    if (level === 'error') return '#f48771';
                    if (level === 'warn') return '#dba617';
                    return '#4ec9b0';
                }

                function formatTs(ts) {
                    try {
                        const d = new Date(ts);
                        return d.toLocaleString('pt-BR', {
                            timeZone: 'America/Sao_Paulo',
                            day: '2-digit',
                            month: '2-digit',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit'
                        });
                    } catch (e) {
                        return ts;
                    }
                }

                function renderLogs(logs) {
                    if (!logs || logs.length === 0) {
                        box.innerHTML = '<span style="color:#646970;">Nenhum log disponível ainda. Execute uma sincronização.</span>';
                        return;
                    }
                    const lines = logs.map(function(e) {
                        const color = levelColor(e.level);
                        const ts = '<span style="color:#858585;">[' + formatTs(e.ts) + ']</span>';
                        const lvl = '<span style="color:' + color + ';font-weight:600;">[' + e.level.toUpperCase() + ']</span>';
                        const msg = '<span style="color:#d4d4d4;">' + e.msg.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span>';
                        return '<div style="margin:1px 0;">' + ts + ' ' + lvl + ' ' + msg + '</div>';
                    });
                    box.innerHTML = lines.join('');
                    box.scrollTop = box.scrollHeight;
                }

                function fetchLogs() {
                    const data = new FormData();
                    data.append('action', 'takai_get_logs');
                    data.append('_ajax_nonce', nonce);
                    fetch(ajaxurl, {
                            method: 'POST',
                            body: data
                        })
                        .then(r => r.json())
                        .then(function(res) {
                            if (res.success) renderLogs(res.data);
                            else box.innerHTML = '<span style="color:#f48771;">Erro ao buscar logs.</span>';
                        })
                        .catch(function() {
                            box.innerHTML = '<span style="color:#f48771;">Falha na comunicação com o servidor.</span>';
                        });
                }

                fetchLogs();
                if (btnRef) btnRef.addEventListener('click', fetchLogs);
            }());

            // ── Force sync ───────────────────────────────────────────────────
            (function() {
                const btn = document.getElementById('takai-sync-btn');
                const status = document.getElementById('takai-sync-status');
                if (!btn) return;

                btn.addEventListener('click', function() {
                    btn.disabled = true;
                    btn.style.background = '#646970';
                    btn.querySelector('.dashicons').style.animation = 'takai-spin 1s linear infinite';
                    status.style.color = '#646970';
                    status.textContent = 'Sincronizando... isso pode levar alguns minutos.';

                    const data = new FormData();
                    data.append('action', 'takai_force_sync');
                    data.append('_ajax_nonce', '<?= esc_js(wp_create_nonce('takai_force_sync')) ?>');

                    fetch(ajaxurl, {
                            method: 'POST',
                            body: data
                        })
                        .then(r => r.json())
                        .then(function(res) {
                            if (res.success) {
                                status.style.color = '#00a32a';
                                status.textContent = '✅ ' + res.data.message;
                            } else {
                                status.style.color = '#d63638';
                                status.textContent = '❌ ' + (res.data?.message ?? 'Erro desconhecido.');
                            }
                            // Atualiza logs após sync
                            const logData = new FormData();
                            logData.append('action', 'takai_get_logs');
                            logData.append('_ajax_nonce', '<?= esc_js(wp_create_nonce('takai_get_logs')) ?>');
                            fetch(ajaxurl, {
                                    method: 'POST',
                                    body: logData
                                })
                                .then(r => r.json())
                                .then(function(r2) {
                                    if (r2.success) {
                                        const box = document.getElementById('takai-logs-box');
                                        if (box) {
                                            const logs = r2.data;
                                            if (!logs || logs.length === 0) return;

                                            function levelColor(l) {
                                                if (l === 'error') return '#f48771';
                                                if (l === 'warn') return '#dba617';
                                                return '#4ec9b0';
                                            }

                                            function formatTs(ts) {
                                                try {
                                                    return new Date(ts).toLocaleString('pt-BR', {
                                                        timeZone: 'America/Sao_Paulo',
                                                        day: '2-digit',
                                                        month: '2-digit',
                                                        year: 'numeric',
                                                        hour: '2-digit',
                                                        minute: '2-digit',
                                                        second: '2-digit'
                                                    });
                                                } catch (e) {
                                                    return ts;
                                                }
                                            }
                                            box.innerHTML = logs.map(function(e) {
                                                const c = levelColor(e.level);
                                                return '<div style="margin:1px 0;"><span style="color:#858585;">[' + formatTs(e.ts) + ']</span> <span style="color:' + c + ';font-weight:600;">[' + e.level.toUpperCase() + ']</span> <span style="color:#d4d4d4;">' + e.msg.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span></div>';
                                            }).join('');
                                            box.scrollTop = box.scrollHeight;
                                        }
                                    }
                                });
                        })
                        .catch(function() {
                            status.style.color = '#d63638';
                            status.textContent = '❌ Falha na comunicação com o servidor.';
                        })
                        .finally(function() {
                            btn.disabled = false;
                            btn.style.background = '#2271b1';
                            btn.querySelector('.dashicons').style.animation = '';
                        });
                });
            }());
        </script>
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
