const crypto = require('crypto');
const { pool } = require('../database');

let ensured = false;
let ensuring = null;

function hashPassword(password) {
    return crypto.createHash('sha256').update(String(password || '')).digest('hex');
}

async function hasTable(tableName) {
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
    `, [tableName]);
    return !!(rows && rows[0] && rows[0].cnt > 0);
}

async function hasColumn(tableName, columnName) {
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
    `, [tableName, columnName]);
    return !!(rows && rows[0] && rows[0].cnt > 0);
}

async function ensureStructure() {
    if (ensured) return;
    if (!ensuring) {
        ensuring = (async () => {
            if (await hasTable('tenants_ejc') && !await hasColumn('tenants_ejc', 'modules_json')) {
                await pool.query('ALTER TABLE tenants_ejc ADD COLUMN modules_json LONGTEXT NULL AFTER estado');
            }

            if (!await hasTable('tenant_module_users')) {
                await pool.query(`
                    CREATE TABLE IF NOT EXISTS tenant_module_users (
                        id INT AUTO_INCREMENT PRIMARY KEY,
                        tenant_id INT NOT NULL,
                        module_code VARCHAR(80) NOT NULL,
                        nome_completo VARCHAR(160) NOT NULL,
                        email VARCHAR(180) NOT NULL,
                        senha_hash VARCHAR(255) NOT NULL,
                        grupo VARCHAR(100) NOT NULL DEFAULT 'Tios',
                        ativo TINYINT(1) NOT NULL DEFAULT 1,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                        UNIQUE KEY uniq_tenant_module_email (tenant_id, module_code, email),
                        KEY idx_tenant_module_users_tenant (tenant_id)
                    )
                `);
            }

            if (!await hasTable('tenant_admin_users')) {
                await pool.query(`
                    CREATE TABLE IF NOT EXISTS tenant_admin_users (
                        id INT AUTO_INCREMENT PRIMARY KEY,
                        tenant_id INT NOT NULL,
                        username VARCHAR(180) NOT NULL,
                        nome_completo VARCHAR(160) NOT NULL,
                        senha_hash VARCHAR(255) NOT NULL,
                        ativo TINYINT(1) NOT NULL DEFAULT 1,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                        UNIQUE KEY uniq_tenant_admin_username (username),
                        KEY idx_tenant_admin_tenant (tenant_id)
                    )
                `);
            }

            if (!await hasTable('system_activity_logs')) {
                await pool.query(`
                    CREATE TABLE IF NOT EXISTS system_activity_logs (
                        id INT AUTO_INCREMENT PRIMARY KEY,
                        system_code VARCHAR(40) NOT NULL,
                        tenant_id INT NULL,
                        actor_type VARCHAR(40) NOT NULL,
                        actor_user_id INT NULL,
                        actor_identifier VARCHAR(180) NULL,
                        actor_name VARCHAR(160) NULL,
                        menu_label VARCHAR(120) NOT NULL,
                        action_label VARCHAR(255) NOT NULL,
                        http_method VARCHAR(10) NOT NULL,
                        request_path VARCHAR(255) NOT NULL,
                        metadata_json LONGTEXT NULL,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        KEY idx_system_activity_logs_scope (system_code, tenant_id, created_at),
                        KEY idx_system_activity_logs_actor (actor_user_id, created_at)
                    )
                `);
            }

            if (await hasTable('usuarios')) {
                if (!await hasColumn('usuarios', 'tenant_id')) {
                    await pool.query('ALTER TABLE usuarios ADD COLUMN tenant_id INT NULL AFTER id');
                }
            }

            ensured = true;
        })();
    }

    try {
        await ensuring;
    } finally {
        ensuring = null;
    }
}

module.exports = {
    ensureStructure,
    hashPassword
};
