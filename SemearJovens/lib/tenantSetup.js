const crypto = require('crypto');
const { pool } = require('../database');

let ensured = false;
let ensurePromise = null;

function hashPassword(password) {
    return crypto.createHash('sha256').update(String(password || '')).digest('hex');
}

async function runAlterIgnoreDuplicate(sql) {
    try {
        await pool.query(sql);
    } catch (err) {
        if (err && (err.code === 'ER_DUP_FIELDNAME' || err.code === 'ER_DUP_KEYNAME')) return;
        throw err;
    }
}

async function hasTable(tableName) {
    try {
        const [rows] = await pool.query(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = ?
        `, [tableName]);
        return !!(rows && rows[0] && rows[0].cnt > 0);
    } catch (_err) {
        const [rows] = await pool.query('SHOW TABLES LIKE ?', [tableName]);
        return Array.isArray(rows) && rows.length > 0;
    }
}

async function hasColumn(tableName, columnName) {
    try {
        const [rows] = await pool.query(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = ?
              AND COLUMN_NAME = ?
        `, [tableName, columnName]);
        return !!(rows && rows[0] && rows[0].cnt > 0);
    } catch (_err) {
        const [rows] = await pool.query(`SHOW COLUMNS FROM \`${tableName}\` LIKE ?`, [columnName]);
        return Array.isArray(rows) && rows.length > 0;
    }
}

async function ensureTenantStructure() {
    if (ensured) return;
    if (ensurePromise) return ensurePromise;

    ensurePromise = (async () => {
        if (!await hasTable('tenants_ejc')) {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS tenants_ejc (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    nome_ejc VARCHAR(160) NOT NULL,
                    paroquia VARCHAR(180) NOT NULL,
                    endereco VARCHAR(255) NULL,
                    cidade VARCHAR(120) NOT NULL,
                    estado VARCHAR(120) NOT NULL,
                    ativo TINYINT(1) NOT NULL DEFAULT 1,
                    motivo_desabilitacao TEXT NULL,
                    desabilitado_em DATETIME NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY uniq_tenant_nome_local (nome_ejc, cidade, estado)
                )
            `);
        }

        if (await hasTable('tenants_ejc') && !await hasColumn('tenants_ejc', 'motivo_desabilitacao')) {
            await pool.query('ALTER TABLE tenants_ejc ADD COLUMN motivo_desabilitacao TEXT NULL AFTER ativo');
        }
        if (await hasTable('tenants_ejc') && !await hasColumn('tenants_ejc', 'desabilitado_em')) {
            await pool.query('ALTER TABLE tenants_ejc ADD COLUMN desabilitado_em DATETIME NULL AFTER motivo_desabilitacao');
        }
        if (await hasTable('tenants_ejc') && !await hasColumn('tenants_ejc', 'estado_atende')) {
            await pool.query('ALTER TABLE tenants_ejc ADD COLUMN estado_atende VARCHAR(120) NULL AFTER estado');
        }
        if (await hasTable('tenants_ejc') && !await hasColumn('tenants_ejc', 'cidade_atende')) {
            await pool.query('ALTER TABLE tenants_ejc ADD COLUMN cidade_atende VARCHAR(120) NULL AFTER estado_atende');
        }
        if (await hasTable('tenants_ejc') && !await hasColumn('tenants_ejc', 'bairros_atendidos')) {
            await pool.query('ALTER TABLE tenants_ejc ADD COLUMN bairros_atendidos LONGTEXT NULL AFTER cidade_atende');
        }

        try {
            await pool.query(
                `INSERT INTO tenants_ejc (id, nome_ejc, paroquia, endereco, cidade, estado, ativo)
                 VALUES (1, 'EJC Inconfidentes', 'Paróquia Bom Jesus do Amparo', NULL, 'Belo Horizonte', 'MG', 1)
                 ON DUPLICATE KEY UPDATE ativo = VALUES(ativo)`
            );
        } catch (errSeedTenant) {
            console.error('Aviso ao garantir tenant padrão:', errSeedTenant && errSeedTenant.message ? errSeedTenant.message : errSeedTenant);
        }

        if (!await hasTable('admin_usuarios')) {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS admin_usuarios (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    username VARCHAR(100) NOT NULL UNIQUE,
                    nome_completo VARCHAR(160) NOT NULL,
                    senha VARCHAR(255) NOT NULL,
                    ativo TINYINT(1) NOT NULL DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
            await runAlterIgnoreDuplicate('ALTER TABLE usuarios ADD COLUMN tenant_id INT NULL AFTER id');
            if (!await hasColumn('usuarios', 'google_id')) {
                await pool.query('ALTER TABLE usuarios ADD COLUMN google_id VARCHAR(255) NULL UNIQUE AFTER id');
            }
            if (!await hasColumn('usuarios', 'avatar_url')) {
                const avatarAfter = await hasColumn('usuarios', 'email') ? 'email' : 'google_id';
                await pool.query(`ALTER TABLE usuarios ADD COLUMN avatar_url TEXT NULL AFTER ${avatarAfter}`);
            }
            await runAlterIgnoreDuplicate('ALTER TABLE usuarios ADD KEY idx_usuarios_tenant (tenant_id)');
            await runAlterIgnoreDuplicate('ALTER TABLE usuarios ADD UNIQUE KEY uniq_usuarios_tenant_username (tenant_id, username)');
            await pool.query('UPDATE usuarios SET tenant_id = 1 WHERE tenant_id IS NULL');
            try {
                await pool.query('ALTER TABLE usuarios MODIFY COLUMN tenant_id INT NOT NULL');
            } catch (errTenantNotNull) {
                if (!errTenantNotNull || errTenantNotNull.code !== 'ER_INVALID_USE_OF_NULL') {
                    throw errTenantNotNull;
                }
            }
        } else {
            throw new Error('Tabela usuarios não encontrada.');
        }

        // Em ambientes antigos, "username" pode estar como UNIQUE global.
        // No modo multitenant o correto é unicidade por tenant.
        try {
            const [idxRows] = await pool.query(`
                SELECT INDEX_NAME, NON_UNIQUE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
                FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = 'usuarios'
                GROUP BY INDEX_NAME, NON_UNIQUE
            `);

            const idxUsernameGlobal = (idxRows || []).find((r) =>
                Number(r.NON_UNIQUE) === 0
                && String(r.cols || '').trim().toLowerCase() === 'username'
                && String(r.INDEX_NAME || '').toUpperCase() !== 'PRIMARY'
            );

            if (idxUsernameGlobal) {
                try {
                    await pool.query(`ALTER TABLE usuarios DROP INDEX \`${idxUsernameGlobal.INDEX_NAME}\``);
                } catch (errDrop) {
                    if (!errDrop || (errDrop.code !== 'ER_CANT_DROP_FIELD_OR_KEY' && errDrop.code !== 'ER_DROP_INDEX_FK')) {
                        throw errDrop;
                    }
                }
            }
        } catch (errIdx) {
            // Não trava bootstrap por falha de introspecção de índice
            console.error('Aviso ao ajustar índice de username para multitenant:', errIdx && errIdx.message ? errIdx.message : errIdx);
        }

        const adminUser = String(process.env.ADMIN_MASTER_USER || 'admin').trim();
        const adminNome = String(process.env.ADMIN_MASTER_NOME || 'Administrador Geral').trim();
        const adminPass = String(process.env.ADMIN_MASTER_PASS || 'admin123').trim();

        if (adminUser && adminPass) {
            try {
                await pool.query(
                    `INSERT INTO admin_usuarios (username, nome_completo, senha, ativo)
                     VALUES (?, ?, ?, 1)
                     ON DUPLICATE KEY UPDATE
                        nome_completo = VALUES(nome_completo),
                        senha = COALESCE(NULLIF(senha, ''), VALUES(senha))`,
                    [adminUser, adminNome || 'Administrador Geral', hashPassword(adminPass)]
                );
            } catch (errSeedAdmin) {
                console.error('Aviso ao garantir admin master:', errSeedAdmin && errSeedAdmin.message ? errSeedAdmin.message : errSeedAdmin);
            }
        }

        ensured = true;
    })();

    try {
        await ensurePromise;
    } finally {
        ensurePromise = null;
    }
}

module.exports = {
    ensureTenantStructure,
    hashPassword
};
