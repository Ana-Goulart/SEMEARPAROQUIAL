const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { pool } = require('../database');

let ensured = false;
let ensurePromise = null;

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);

function hashLegacyPassword(password) {
    return crypto.createHash('sha256').update(String(password || '')).digest('hex');
}

function looksLikeBcryptHash(value) {
    return /^\$2[aby]\$\d{2}\$/.test(String(value || ''));
}

async function hashPassword(password) {
    return bcrypt.hash(String(password || ''), BCRYPT_ROUNDS);
}

async function verifyPassword(password, storedHash) {
    const plain = String(password || '');
    const saved = String(storedHash || '');
    if (!saved) return false;
    if (looksLikeBcryptHash(saved)) return bcrypt.compare(plain, saved);
    return hashLegacyPassword(plain) === saved;
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

        // Migração: remove tenant_id herdado da versão SemearAdmin das tabelas QA globais
        for (const tbl of ['qa_menus', 'qa_releases', 'qa_testes', 'qa_menu_funcionalidades', 'qa_testes_funcionalidades']) {
            if (await hasTable(tbl) && await hasColumn(tbl, 'tenant_id')) {
                try {
                    const [idxRows] = await pool.query(`
                        SELECT INDEX_NAME FROM information_schema.STATISTICS
                        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'tenant_id'
                        GROUP BY INDEX_NAME`, [tbl]);
                    for (const r of idxRows) {
                        try { await pool.query(`ALTER TABLE \`${tbl}\` DROP INDEX \`${r.INDEX_NAME}\``); } catch (_) {}
                    }
                    await pool.query(`ALTER TABLE \`${tbl}\` DROP COLUMN tenant_id`);
                } catch (errMig) {
                    console.error(`Aviso ao remover tenant_id de ${tbl}:`, errMig && errMig.message ? errMig.message : errMig);
                }
            }
        }

        if (!await hasTable('qa_menus')) {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS qa_menus (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    nome VARCHAR(120) NOT NULL,
                    submenu_de INT NULL,
                    ativo TINYINT(1) NOT NULL DEFAULT 1,
                    ordem INT NOT NULL DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
        }

        if (!await hasTable('qa_releases')) {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS qa_releases (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    versao VARCHAR(20) NOT NULL,
                    descricao TEXT,
                    status ENUM('em_teste', 'aprovado', 'reprovado') NOT NULL DEFAULT 'em_teste',
                    ambiente ENUM('homologacao', 'producao') NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )
            `);
        }

        if (!await hasTable('qa_testes')) {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS qa_testes (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    release_id INT NOT NULL,
                    menu_id INT NOT NULL,
                    alterado TINYINT(1) NOT NULL DEFAULT 0,
                    descricao_alteracao TEXT,
                    status ENUM('nao_testado', 'ok', 'falhou', 'parcial') NOT NULL DEFAULT 'nao_testado',
                    observacao TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY uq_qa_testes_release_menu (release_id, menu_id)
                )
            `);
        }

        // Migração: renomear tabelas antigas se existirem
        if (await hasTable('qa_menu_tarefas') && !await hasTable('qa_menu_funcionalidades')) {
            await pool.query('RENAME TABLE qa_menu_tarefas TO qa_menu_funcionalidades');
        }
        if (await hasTable('qa_testes_tarefas') && !await hasTable('qa_testes_funcionalidades')) {
            await pool.query('RENAME TABLE qa_testes_tarefas TO qa_testes_funcionalidades');
        }

        if (!await hasTable('qa_menu_funcionalidades')) {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS qa_menu_funcionalidades (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    menu_id INT NOT NULL,
                    descricao VARCHAR(255) NOT NULL,
                    ativo TINYINT(1) NOT NULL DEFAULT 1,
                    ordem INT NOT NULL DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    KEY idx_qa_menu_funcionalidades_menu (menu_id)
                )
            `);
        }

        if (!await hasTable('qa_testes_funcionalidades')) {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS qa_testes_funcionalidades (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    release_id INT NOT NULL,
                    funcionalidade_id INT NOT NULL,
                    status ENUM('nao_testado', 'ok', 'falhou', 'parcial') NOT NULL DEFAULT 'nao_testado',
                    observacao TEXT,
                    alterado TINYINT(1) NOT NULL DEFAULT 0,
                    tipo_alteracao ENUM('funcionalidade','bug') NULL,
                    descricao_alteracao TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY uq_qa_testes_funcionalidades (release_id, funcionalidade_id)
                )
            `);
        }

        // Migração: renomear coluna tarefa_id → funcionalidade_id
        if (await hasTable('qa_testes_funcionalidades') && await hasColumn('qa_testes_funcionalidades', 'tarefa_id') && !await hasColumn('qa_testes_funcionalidades', 'funcionalidade_id')) {
            try {
                await pool.query('ALTER TABLE qa_testes_funcionalidades RENAME COLUMN tarefa_id TO funcionalidade_id');
            } catch (errRename) {
                console.error('Aviso ao renomear tarefa_id:', errRename && errRename.message ? errRename.message : errRename);
            }
        }

        // Migração: adicionar novas colunas em qa_testes_funcionalidades
        if (await hasTable('qa_testes_funcionalidades') && !await hasColumn('qa_testes_funcionalidades', 'alterado')) {
            await pool.query('ALTER TABLE qa_testes_funcionalidades ADD COLUMN alterado TINYINT(1) NOT NULL DEFAULT 0');
        }
        if (await hasTable('qa_testes_funcionalidades') && !await hasColumn('qa_testes_funcionalidades', 'tipo_alteracao')) {
            await pool.query("ALTER TABLE qa_testes_funcionalidades ADD COLUMN tipo_alteracao ENUM('funcionalidade','bug') NULL");
        }
        if (await hasTable('qa_testes_funcionalidades') && !await hasColumn('qa_testes_funcionalidades', 'descricao_alteracao')) {
            await pool.query('ALTER TABLE qa_testes_funcionalidades ADD COLUMN descricao_alteracao TEXT');
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
                    [adminUser, adminNome || 'Administrador Geral', await hashPassword(adminPass)]
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
    hashPassword,
    verifyPassword,
    looksLikeBcryptHash
};
