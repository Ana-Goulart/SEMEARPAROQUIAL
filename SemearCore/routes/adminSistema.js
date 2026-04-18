const express = require('express');
const { pool } = require('../database');
const { ensureTenantStructure, hashPassword } = require('../lib/tenantSetup');
const { setAdminSessionCookie, clearAdminSessionCookie } = require('../lib/adminSession');

const router = express.Router();
const GRUPO_ADMIN_LOCAL = 'Tios';
const GRUPOS_VALIDOS_SEMEAR_JOVENS = new Set(['Tios', 'Jovens', 'Diretor Espiritual', 'Padre']);
const TENANT_SCOPED_TABLES = [
    'usuarios',
    'ejc',
    'outros_ejcs',
    'jovens',
    'historico_equipes',
    'jovens_comissoes',
    'jovens_observacoes',
    'equipes',
    'equipes_ejc',
    'equipes_funcoes',
    'equipes_papeis',
    'equipes_funcoes_padrao',
    'montagens',
    'montagem_membros',
    'montagem_jovens_servir',
    'formularios_pastas',
    'formularios_itens',
    'formularios_presencas',
    'financeiro_movimentacoes',
    'circulos',
    'coordenadores',
    'coordenacoes',
    'coordenacoes_membros',
    'coordenacoes_pastas'
];
const MODULE_DEFINITIONS = [
    { code: 'semear-jovens', nome: 'EJC' },
    { code: 'semear-catequese', nome: 'Semear Catequese' }
];
const MODULE_CODES = new Set(MODULE_DEFINITIONS.map((item) => item.code));
const SYSTEM_MODULE_DEFINITIONS = [
    { code: 'semear-core-admin', nome: 'Administração Geral' },
    { code: 'semear-admin', nome: 'Admin da Paróquia' }
];
const SUPPORT_MESSAGE_STATUS = new Set(['NOVA', 'EM_ANALISE', 'SOLUCIONADA', 'ENCERRADA']);
const DEFAULT_PARISH_ADMIN_NAME = 'Administrador da Paróquia';
const AUTOR_ADMIN = 'ADMIN';
const AUTOR_USUARIO = 'USUARIO';

function requireAdmin(req, res, next) {
    if (!req.admin || !req.admin.id) return res.status(401).json({ error: 'Não autenticado no painel admin.' });
    next();
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

async function listTenantScopedTables(connection) {
    const [rows] = await connection.query(`
        SELECT DISTINCT TABLE_NAME AS table_name
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND COLUMN_NAME = 'tenant_id'
          AND TABLE_NAME <> 'tenants_ejc'
    `);
    return Array.isArray(rows) ? rows.map((r) => String(r.table_name || '').trim()).filter(Boolean) : [];
}

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeUsername(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeModuleCode(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeGrupoLocal(value) {
    const grupo = String(value || '').trim();
    if (!grupo) return GRUPO_ADMIN_LOCAL;
    return GRUPOS_VALIDOS_SEMEAR_JOVENS.has(grupo) ? grupo : GRUPO_ADMIN_LOCAL;
}

function parseModulesJson(rawValue) {
    if (!rawValue) return [];
    try {
        const parsed = JSON.parse(rawValue);
        if (!Array.isArray(parsed)) return [];
        const unique = [];
        const seen = new Set();
        for (const item of parsed) {
            const code = normalizeModuleCode(item);
            if (!code || !MODULE_CODES.has(code) || seen.has(code)) continue;
            seen.add(code);
            unique.push(code);
        }
        return unique;
    } catch (_err) {
        return [];
    }
}

function normalizeModules(input) {
    if (!Array.isArray(input)) return [];
    const unique = [];
    const seen = new Set();
    for (const item of input) {
        const code = normalizeModuleCode(item);
        if (!code || !MODULE_CODES.has(code) || seen.has(code)) continue;
        seen.add(code);
        unique.push(code);
    }
    return unique;
}

function getOverviewModuleName(code) {
    return OVERVIEW_MODULE_DEFINITIONS.find((item) => item.code === code)?.nome || code;
}

function normalizeModuleUsers(input) {
    if (!Array.isArray(input)) return [];
    const result = [];
    for (const item of input) {
        const moduleCode = normalizeModuleCode(item && item.module_code);
        if (!moduleCode || !MODULE_CODES.has(moduleCode)) continue;
        const nomeCompleto = String(item && item.nome_completo ? item.nome_completo : '').trim();
        const email = normalizeEmail(item && item.email);
        const senha = String(item && item.senha ? item.senha : '');
        const grupo = normalizeGrupoLocal(item && item.grupo ? item.grupo : GRUPO_ADMIN_LOCAL);
        if (!nomeCompleto || !email || !senha) continue;
        result.push({ moduleCode, nomeCompleto, email, senha, grupo });
    }
    return result;
}

async function ensureAdminFeatureStructure() {
    await ensureTenantStructure();

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

    if (!await hasTable('support_messages')) {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS support_messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tenant_id INT NULL,
                module_code VARCHAR(80) NOT NULL,
                user_id INT NULL,
                user_nome VARCHAR(180) NOT NULL,
                user_login VARCHAR(180) NULL,
                assunto VARCHAR(180) NOT NULL,
                mensagem TEXT NOT NULL,
                status VARCHAR(30) NOT NULL DEFAULT 'NOVA',
                lida_em DATETIME NULL,
                respondida_em DATETIME NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                KEY idx_support_messages_tenant (tenant_id),
                KEY idx_support_messages_module (module_code),
                KEY idx_support_messages_status (status)
            )
        `);
    }
    if (!await hasColumn('support_messages', 'solucionada_em')) {
        await pool.query('ALTER TABLE support_messages ADD COLUMN solucionada_em DATETIME NULL AFTER respondida_em');
    }
    if (!await hasColumn('support_messages', 'confirmada_em')) {
        await pool.query('ALTER TABLE support_messages ADD COLUMN confirmada_em DATETIME NULL AFTER solucionada_em');
    }
    if (!await hasColumn('support_messages', 'confirmada_por_user_id')) {
        await pool.query('ALTER TABLE support_messages ADD COLUMN confirmada_por_user_id INT NULL AFTER confirmada_em');
    }

    if (!await hasTable('support_message_replies')) {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS support_message_replies (
                id INT AUTO_INCREMENT PRIMARY KEY,
                support_message_id INT NOT NULL,
                tenant_id INT NULL,
                author_type VARCHAR(30) NOT NULL,
                author_name VARCHAR(180) NOT NULL,
                author_login VARCHAR(180) NULL,
                message TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                KEY idx_support_message_replies_message (support_message_id),
                KEY idx_support_message_replies_tenant (tenant_id)
            )
        `);
    }
}

async function upsertTenantAdminUser(connection, { tenantId, username, nomeCompleto, senha, ativo }) {
    const safeUsername = normalizeUsername(username);
    const safeName = String(nomeCompleto || DEFAULT_PARISH_ADMIN_NAME).trim() || DEFAULT_PARISH_ADMIN_NAME;
    const safePassword = String(senha || '').trim();
    if (!safeUsername || !safePassword) return;

    await connection.query(
        `INSERT INTO tenant_admin_users (tenant_id, username, nome_completo, senha_hash, ativo)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            tenant_id = VALUES(tenant_id),
            nome_completo = VALUES(nome_completo),
            senha_hash = VALUES(senha_hash),
            ativo = VALUES(ativo)`,
        [tenantId, safeUsername, safeName, hashPassword(safePassword), ativo ? 1 : 0]
    );
}

async function syncLocalSemearJovensUser(connection, { tenantId, nomeCompleto, email, senha, grupo }) {
    const username = normalizeEmail(email);
    if (!username) return;

    const grupoSeguro = normalizeGrupoLocal(grupo);
    const [rows] = await connection.query(
        'SELECT id FROM usuarios WHERE tenant_id = ? AND username = ? LIMIT 1',
        [tenantId, username]
    );
    if (rows.length) {
        let query = 'UPDATE usuarios SET nome_completo = ?, grupo = ?';
        const params = [String(nomeCompleto || '').trim(), grupoSeguro];
        if (senha) {
            query += ', senha = ?';
            params.push(hashPassword(senha));
        }
        query += ' WHERE id = ?';
        params.push(rows[0].id);
        await connection.query(query, params);
        return;
    }

    await connection.query(
        'INSERT INTO usuarios (tenant_id, username, nome_completo, senha, grupo) VALUES (?, ?, ?, ?, ?)',
        [tenantId, username, String(nomeCompleto || '').trim(), hashPassword(senha || ''), grupoSeguro]
    );
}

async function listTenantModuleUsers(tenantIds) {
    const ids = Array.isArray(tenantIds)
        ? tenantIds.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
        : [Number(tenantIds)].filter((value) => Number.isInteger(value) && value > 0);
    if (!ids.length) return [];

    const [rows] = await pool.query(
        `SELECT id, tenant_id, module_code, nome_completo, email, grupo, ativo, created_at, updated_at
         FROM tenant_module_users
         WHERE tenant_id IN (?) AND ativo = 1
         ORDER BY tenant_id ASC, module_code ASC, nome_completo ASC`,
        [ids]
    );
    return rows;
}

async function listUsersOverview() {
    await ensureAdminFeatureStructure();

    const modulesMap = new Map(
        MODULE_DEFINITIONS.map((item) => [item.code, {
            module_code: item.code,
            module_nome: item.nome,
            total_usuarios: 0,
            usuarios: []
        }])
    );

    if (await hasTable('usuarios')) {
        const [rows] = await pool.query(`
            SELECT u.id, u.tenant_id, u.nome_completo, u.username, u.grupo, u.created_at,
                   t.nome_ejc, t.paroquia
            FROM usuarios u
            LEFT JOIN tenants_ejc t ON t.id = u.tenant_id
            WHERE u.tenant_id IS NOT NULL
            ORDER BY t.nome_ejc ASC, u.nome_completo ASC
        `);
        const modulo = modulesMap.get('semear-jovens');
        for (const row of rows) {
            modulo.usuarios.push({
                id: row.id,
                tenant_id: row.tenant_id,
                tenant_nome: row.nome_ejc || '-',
                paroquia: row.paroquia || '-',
                nome_completo: row.nome_completo,
                login: row.username,
                grupo: row.grupo || '-',
                origem: 'usuarios',
                created_at: row.created_at
            });
        }
    }

    if (await hasTable('tenant_module_users')) {
        const [rows] = await pool.query(`
            SELECT mu.id, mu.tenant_id, mu.module_code, mu.nome_completo, mu.email, mu.grupo, mu.created_at,
                   t.nome_ejc, t.paroquia
            FROM tenant_module_users mu
            LEFT JOIN tenants_ejc t ON t.id = mu.tenant_id
            WHERE mu.ativo = 1
              AND mu.module_code <> 'semear-jovens'
            ORDER BY mu.module_code ASC, t.nome_ejc ASC, mu.nome_completo ASC
        `);
        for (const row of rows) {
            if (!modulesMap.has(row.module_code)) {
                modulesMap.set(row.module_code, {
                    module_code: row.module_code,
                    module_nome: getOverviewModuleName(row.module_code),
                    total_usuarios: 0,
                    usuarios: []
                });
            }
            modulesMap.get(row.module_code).usuarios.push({
                id: row.id,
                tenant_id: row.tenant_id,
                tenant_nome: row.nome_ejc || '-',
                paroquia: row.paroquia || '-',
                nome_completo: row.nome_completo,
                login: row.email,
                grupo: row.grupo || '-',
                origem: 'tenant_module_users',
                created_at: row.created_at
            });
        }
    }

    return Array.from(modulesMap.values()).map((item) => ({
        ...item,
        total_usuarios: item.usuarios.length,
        total_tenants: new Set(
            item.usuarios
                .map((usuario) => Number(usuario.tenant_id))
                .filter((tenantId) => Number.isInteger(tenantId) && tenantId > 0)
        ).size
    }));
}

async function listSystemUsersOverview() {
    await ensureAdminFeatureStructure();

    const modulesMap = new Map(
        SYSTEM_MODULE_DEFINITIONS
            .filter((item) => item.code === 'semear-core-admin')
            .map((item) => [item.code, {
            module_code: item.code,
            module_nome: item.nome,
            total_usuarios: 0,
            usuarios: []
        }])
    );

    if (await hasTable('admin_usuarios')) {
        const [rows] = await pool.query(`
            SELECT id, username, nome_completo, created_at
            FROM admin_usuarios
            WHERE ativo = 1
            ORDER BY nome_completo ASC
        `);
        const modulo = modulesMap.get('semear-core-admin');
        for (const row of rows) {
            modulo.usuarios.push({
                id: row.id,
                tenant_id: null,
                tenant_nome: 'Administração Geral',
                paroquia: '-',
                nome_completo: row.nome_completo,
                login: row.username,
                grupo: 'Administrador Geral',
                origem: 'admin_usuarios',
                created_at: row.created_at
            });
        }
    }

    return Array.from(modulesMap.values()).map((item) => ({
        ...item,
        total_usuarios: item.usuarios.length,
        total_tenants: new Set(
            item.usuarios
                .map((usuario) => Number(usuario.tenant_id))
                .filter((tenantId) => Number.isInteger(tenantId) && tenantId > 0)
        ).size
    }));
}

router.get('/admin-users', requireAdmin, async (_req, res) => {
    try {
        await ensureAdminFeatureStructure();
        const [rows] = await pool.query(`
            SELECT id, username, nome_completo, ativo, created_at
            FROM admin_usuarios
            ORDER BY nome_completo ASC, username ASC
        `);
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar usuários do sistema:', err);
        return res.status(500).json({ error: 'Erro ao listar usuários do sistema.' });
    }
});

router.post('/admin-users', requireAdmin, async (req, res) => {
    try {
        await ensureAdminFeatureStructure();
        const username = normalizeEmail(req.body.username);
        const nomeCompleto = String(req.body.nome_completo || '').trim();
        const senha = String(req.body.senha || '').trim();

        if (!username || !nomeCompleto || !senha) {
            return res.status(400).json({ error: 'Preencha nome completo, login e senha.' });
        }

        const [result] = await pool.query(
            'INSERT INTO admin_usuarios (username, nome_completo, senha, ativo) VALUES (?, ?, ?, 1)',
            [username, nomeCompleto, hashPassword(senha)]
        );
        return res.status(201).json({ id: result.insertId, message: 'Usuário do sistema criado com sucesso.' });
    } catch (err) {
        console.error('Erro ao criar usuário do sistema:', err);
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Já existe um usuário com este login.' });
        }
        return res.status(500).json({ error: 'Erro ao criar usuário do sistema.' });
    }
});

router.put('/admin-users/:id', requireAdmin, async (req, res) => {
    try {
        await ensureAdminFeatureStructure();
        const adminUserId = Number(req.params.id);
        if (!Number.isInteger(adminUserId) || adminUserId <= 0) {
            return res.status(400).json({ error: 'Usuário inválido.' });
        }

        const username = normalizeEmail(req.body.username);
        const nomeCompleto = String(req.body.nome_completo || '').trim();
        const senha = String(req.body.senha || '').trim();
        const ativo = req.body.ativo === false ? 0 : 1;

        if (!username || !nomeCompleto) {
            return res.status(400).json({ error: 'Preencha nome completo e login.' });
        }

        let query = 'UPDATE admin_usuarios SET username = ?, nome_completo = ?, ativo = ?';
        const params = [username, nomeCompleto, ativo];
        if (senha) {
            query += ', senha = ?';
            params.push(hashPassword(senha));
        }
        query += ' WHERE id = ?';
        params.push(adminUserId);

        const [result] = await pool.query(query, params);
        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }
        return res.json({ message: 'Usuário do sistema atualizado com sucesso.' });
    } catch (err) {
        console.error('Erro ao atualizar usuário do sistema:', err);
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Já existe um usuário com este login.' });
        }
        return res.status(500).json({ error: 'Erro ao atualizar usuário do sistema.' });
    }
});

router.delete('/admin-users/:id', requireAdmin, async (req, res) => {
    try {
        await ensureAdminFeatureStructure();
        const adminUserId = Number(req.params.id);
        if (!Number.isInteger(adminUserId) || adminUserId <= 0) {
            return res.status(400).json({ error: 'Usuário inválido.' });
        }
        if (Number(req.admin && req.admin.id) === adminUserId) {
            return res.status(400).json({ error: 'Você não pode excluir o seu próprio usuário logado.' });
        }

        const [[countRow]] = await pool.query(
            'SELECT COUNT(*) AS total FROM admin_usuarios WHERE ativo = 1'
        );
        const [[userRow]] = await pool.query(
            'SELECT id, ativo FROM admin_usuarios WHERE id = ? LIMIT 1',
            [adminUserId]
        );
        if (!userRow) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }
        if (Number(userRow.ativo) === 1 && Number(countRow && countRow.total) <= 1) {
            return res.status(400).json({ error: 'Não é possível excluir o último usuário ativo do sistema.' });
        }

        const [result] = await pool.query('DELETE FROM admin_usuarios WHERE id = ?', [adminUserId]);
        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }
        return res.json({ message: 'Usuário do sistema excluído com sucesso.' });
    } catch (err) {
        console.error('Erro ao excluir usuário do sistema:', err);
        return res.status(500).json({ error: 'Erro ao excluir usuário do sistema.' });
    }
});

function normalizeReplyRows(rows, fallbackMessage) {
    const list = Array.isArray(rows) ? [...rows] : [];
    if (!list.length && fallbackMessage && fallbackMessage.mensagem) {
        list.push({
            id: `legacy-${fallbackMessage.id}`,
            author_type: AUTOR_USUARIO,
            author_name: fallbackMessage.user_nome,
            author_login: fallbackMessage.user_login,
            message: fallbackMessage.mensagem,
            created_at: fallbackMessage.created_at
        });
    }
    return list;
}

async function loadSupportRepliesByMessageIds(messageIds) {
    const ids = Array.isArray(messageIds)
        ? messageIds.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
        : [];
    if (!ids.length) return new Map();

    const [rows] = await pool.query(
        `SELECT id, support_message_id, author_type, author_name, author_login, message, created_at
         FROM support_message_replies
         WHERE support_message_id IN (?)
         ORDER BY created_at ASC, id ASC`,
        [ids]
    );

    const map = new Map();
    for (const row of rows) {
        const key = Number(row.support_message_id);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(row);
    }
    return map;
}

router.get('/me', async (req, res) => {
    try {
        await ensureTenantStructure();
        if (!req.admin || !req.admin.id) return res.json({ logged: false });
        const [rows] = await pool.query(
            'SELECT id, username, nome_completo, ativo FROM admin_usuarios WHERE id = ? LIMIT 1',
            [req.admin.id]
        );
        if (!rows.length || !rows[0].ativo) return res.json({ logged: false });
        return res.json({ logged: true, user: rows[0] });
    } catch (err) {
        console.error('Erro ao obter sessão admin:', err);
        return res.status(500).json({ error: 'Erro ao obter sessão admin.' });
    }
});

router.post('/login', async (req, res) => {
    try {
        await ensureTenantStructure();
        const username = String(req.body.username || '').trim();
        const senha = String(req.body.senha || '');
        if (!username || !senha) {
            return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
        }
        const [rows] = await pool.query(
            'SELECT id, username, nome_completo, senha, ativo FROM admin_usuarios WHERE username = ? LIMIT 1',
            [username]
        );
        if (!rows.length || !rows[0].ativo) return res.status(401).json({ error: 'Credenciais inválidas.' });
        if (rows[0].senha !== hashPassword(senha)) return res.status(401).json({ error: 'Credenciais inválidas.' });

        setAdminSessionCookie(res, rows[0].id);
        return res.json({
            message: 'Login admin efetuado com sucesso.',
            user: { id: rows[0].id, username: rows[0].username, nome_completo: rows[0].nome_completo }
        });
    } catch (err) {
        console.error('Erro no login admin:', err);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

router.post('/logout', (_req, res) => {
    clearAdminSessionCookie(res);
    return res.json({ message: 'Logout admin efetuado.' });
});

router.get('/modules', requireAdmin, async (_req, res) => {
    try {
        await ensureAdminFeatureStructure();
        return res.json(MODULE_DEFINITIONS);
    } catch (err) {
        console.error('Erro ao listar módulos:', err);
        return res.status(500).json({ error: 'Erro ao listar módulos.' });
    }
});

router.get('/users-overview', requireAdmin, async (_req, res) => {
    try {
        const modules = await listUsersOverview();
        return res.json(modules);
    } catch (err) {
        console.error('Erro ao carregar visão global de usuários:', err);
        return res.status(500).json({ error: 'Erro ao carregar usuários atuais de todos os sistemas.' });
    }
});

router.get('/system-users', requireAdmin, async (_req, res) => {
    try {
        const modules = await listSystemUsersOverview();
        return res.json(modules);
    } catch (err) {
        console.error('Erro ao carregar usuários do sistema:', err);
        return res.status(500).json({ error: 'Erro ao carregar usuários do sistema.' });
    }
});

router.get('/support-messages', requireAdmin, async (_req, res) => {
    try {
        await ensureAdminFeatureStructure();
        const [rows] = await pool.query(`
            SELECT sm.id, sm.tenant_id, sm.module_code, sm.user_id, sm.user_nome, sm.user_login,
                   sm.assunto, sm.mensagem, sm.status, sm.lida_em, sm.respondida_em, sm.solucionada_em,
                   sm.confirmada_em, sm.confirmada_por_user_id, sm.created_at, sm.updated_at,
                   t.nome_ejc, t.paroquia
            FROM support_messages sm
            LEFT JOIN tenants_ejc t ON t.id = sm.tenant_id
            ORDER BY
                CASE sm.status
                    WHEN 'NOVA' THEN 0
                    WHEN 'EM_ANALISE' THEN 1
                    WHEN 'SOLUCIONADA' THEN 2
                    ELSE 3
                END,
                sm.created_at DESC
        `);
        const repliesMap = await loadSupportRepliesByMessageIds(rows.map((item) => item.id));
        const result = rows.map((item) => ({
            ...item,
            conversa: normalizeReplyRows(repliesMap.get(Number(item.id)), item)
        }));
        return res.json(result);
    } catch (err) {
        console.error('Erro ao listar mensagens de ajuda:', err);
        return res.status(500).json({ error: 'Erro ao listar mensagens.' });
    }
});

router.patch('/support-messages/:id/status', requireAdmin, async (req, res) => {
    const messageId = Number(req.params.id);
    const status = String(req.body.status || '').trim().toUpperCase();

    if (!Number.isInteger(messageId) || messageId <= 0) {
        return res.status(400).json({ error: 'Mensagem inválida.' });
    }
    if (!SUPPORT_MESSAGE_STATUS.has(status)) {
        return res.status(400).json({ error: 'Status inválido.' });
    }

    try {
        await ensureAdminFeatureStructure();
        const [result] = await pool.query(
            `UPDATE support_messages
             SET status = ?,
                 lida_em = CASE
                     WHEN ? IN ('EM_ANALISE', 'SOLUCIONADA', 'ENCERRADA') THEN COALESCE(lida_em, NOW())
                     ELSE lida_em
                 END,
                 respondida_em = CASE
                     WHEN ? IN ('EM_ANALISE', 'SOLUCIONADA', 'ENCERRADA') THEN COALESCE(respondida_em, NOW())
                     ELSE respondida_em
                 END,
                 solucionada_em = CASE
                     WHEN ? = 'SOLUCIONADA' THEN NOW()
                     WHEN ? IN ('NOVA', 'EM_ANALISE') THEN NULL
                     ELSE solucionada_em
                 END,
                 confirmada_em = CASE
                     WHEN ? IN ('NOVA', 'EM_ANALISE', 'SOLUCIONADA') THEN NULL
                     ELSE confirmada_em
                 END,
                 confirmada_por_user_id = CASE
                     WHEN ? IN ('NOVA', 'EM_ANALISE', 'SOLUCIONADA') THEN NULL
                     ELSE confirmada_por_user_id
                 END
             WHERE id = ?`,
            [status, status, status, status, status, status, status, messageId]
        );
        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Mensagem não encontrada.' });
        }
        return res.json({ message: 'Status da mensagem atualizado com sucesso.' });
    } catch (err) {
        console.error('Erro ao atualizar status da mensagem:', err);
        return res.status(500).json({ error: 'Erro ao atualizar a mensagem.' });
    }
});

router.post('/support-messages/:id/replies', requireAdmin, async (req, res) => {
    const messageId = Number(req.params.id);
    const message = String(req.body.message || '').trim();

    if (!Number.isInteger(messageId) || messageId <= 0) {
        return res.status(400).json({ error: 'Mensagem inválida.' });
    }
    if (!message || message.length < 2) {
        return res.status(400).json({ error: 'Escreva a resposta da conversa.' });
    }

    try {
        await ensureAdminFeatureStructure();
        const [[adminUser]] = await pool.query(
            'SELECT id, username, nome_completo FROM admin_usuarios WHERE id = ? LIMIT 1',
            [req.admin.id]
        );
        const [[ticket]] = await pool.query(
            'SELECT id, tenant_id FROM support_messages WHERE id = ? LIMIT 1',
            [messageId]
        );
        if (!ticket) {
            return res.status(404).json({ error: 'Mensagem não encontrada.' });
        }

        await pool.query(
            `INSERT INTO support_message_replies
             (support_message_id, tenant_id, author_type, author_name, author_login, message)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                messageId,
                ticket.tenant_id || null,
                AUTOR_ADMIN,
                String((adminUser && adminUser.nome_completo) || 'Administradora').trim(),
                String((adminUser && adminUser.username) || '').trim() || null,
                message
            ]
        );
        await pool.query(
            `UPDATE support_messages
             SET status = ?,
                 lida_em = COALESCE(lida_em, NOW()),
                 respondida_em = NOW(),
                 solucionada_em = NULL,
                 confirmada_em = NULL,
                 confirmada_por_user_id = NULL
             WHERE id = ?`,
            ['EM_ANALISE', messageId]
        );

        return res.status(201).json({ message: 'Resposta enviada com sucesso.' });
    } catch (err) {
        console.error('Erro ao responder mensagem de ajuda:', err);
        return res.status(500).json({ error: 'Erro ao responder a mensagem.' });
    }
});

router.get('/tenants', requireAdmin, async (_req, res) => {
    try {
        await ensureAdminFeatureStructure();
        const [rows] = await pool.query(`
            SELECT t.*,
                   u.id AS usuario_id,
                   u.username AS usuario_username,
                   ta.username AS admin_username,
                   ta.nome_completo AS admin_nome_completo,
                   ta.ativo AS admin_ativo
            FROM tenants_ejc t
            LEFT JOIN usuarios u ON u.id = (
                SELECT ux.id
                FROM usuarios ux
                WHERE ux.tenant_id = t.id
                ORDER BY ux.id ASC
                LIMIT 1
            )
            LEFT JOIN tenant_admin_users ta ON ta.id = (
                SELECT tax.id
                FROM tenant_admin_users tax
                WHERE tax.tenant_id = t.id
                ORDER BY tax.id ASC
                LIMIT 1
            )
            ORDER BY t.estado ASC, t.cidade ASC, t.nome_ejc ASC
        `);

        const tenantIds = rows.map((item) => item.id);
        const moduleUsers = await listTenantModuleUsers(tenantIds);
        const moduleUsersMap = new Map();
        for (const user of moduleUsers) {
            const key = Number(user.tenant_id);
            if (!moduleUsersMap.has(key)) moduleUsersMap.set(key, []);
            moduleUsersMap.get(key).push(user);
        }

        const result = rows.map((item) => ({
            ...item,
            modules: parseModulesJson(item.modules_json),
            module_users: moduleUsersMap.get(Number(item.id)) || []
        }));

        return res.json(result);
    } catch (err) {
        console.error('Erro ao listar tenants:', err);
        return res.status(500).json({ error: 'Erro ao listar EJCs.' });
    }
});

router.put('/tenants/:id', requireAdmin, async (req, res) => {
    const tenantId = Number(req.params.id);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ error: 'Tenant inválido.' });
    }

    const nomeEjc = String(req.body.nome_ejc || req.body.paroquia || '').trim();
    const paroquia = String(req.body.paroquia || '').trim();
    const endereco = String(req.body.endereco || '').trim() || null;
    const cidade = String(req.body.cidade || '').trim();
    const estado = String(req.body.estado || '').trim();
    const modules = normalizeModules(req.body.modules);
    const adminUsername = normalizeUsername(req.body.admin_username);
    const adminNome = String(req.body.admin_nome || DEFAULT_PARISH_ADMIN_NAME).trim() || DEFAULT_PARISH_ADMIN_NAME;
    const adminSenha = String(req.body.admin_senha || '').trim();

    if (!paroquia || !cidade || !estado) {
        return res.status(400).json({ error: 'Preencha paróquia, cidade e estado.' });
    }

    try {
        await ensureAdminFeatureStructure();
        const [result] = await pool.query(
            `UPDATE tenants_ejc
             SET nome_ejc = ?, paroquia = ?, endereco = ?, cidade = ?, estado = ?, modules_json = ?
             WHERE id = ?`,
            [nomeEjc, paroquia, endereco, cidade, estado, JSON.stringify(modules), tenantId]
        );
        if (!result.affectedRows) {
            return res.status(404).json({ error: 'EJC não encontrado.' });
        }

        if (modules.length) {
            await pool.query(
                `UPDATE tenant_module_users
                 SET ativo = CASE WHEN module_code IN (?) THEN 1 ELSE 0 END
                 WHERE tenant_id = ?`,
                [modules, tenantId]
            );
        } else {
            await pool.query('UPDATE tenant_module_users SET ativo = 0 WHERE tenant_id = ?', [tenantId]);
        }

        if (adminUsername) {
            const connection = await pool.getConnection();
            try {
                await connection.beginTransaction();
                if (adminSenha) {
                    await upsertTenantAdminUser(connection, {
                        tenantId,
                        username: adminUsername,
                        nomeCompleto: adminNome,
                        senha: adminSenha,
                        ativo: true
                    });
                } else {
                    const [upd] = await connection.query(
                        `UPDATE tenant_admin_users
                         SET username = ?, nome_completo = ?, ativo = 1
                         WHERE tenant_id = ?`,
                        [adminUsername, adminNome, tenantId]
                    );
                    if (!upd.affectedRows) {
                        throw new Error('Informe a senha do admin da paróquia para criar o primeiro acesso.');
                    }
                }
                await connection.commit();
            } catch (errUpsert) {
                await connection.rollback();
                throw errUpsert;
            } finally {
                connection.release();
            }
        }

        return res.json({ message: 'EJC atualizado com sucesso.' });
    } catch (err) {
        console.error('Erro ao atualizar tenant:', err);
        if (err && err.message === 'Informe a senha do admin da paróquia para criar o primeiro acesso.') {
            return res.status(400).json({ error: err.message });
        }
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Já existe EJC com esse nome/cidade/estado.' });
        }
        return res.status(500).json({ error: 'Erro ao atualizar EJC.' });
    }
});

router.patch('/tenants/:id/status', requireAdmin, async (req, res) => {
    const tenantId = Number(req.params.id);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ error: 'Tenant inválido.' });
    }

    const ativo = !!req.body.ativo;
    const motivo = String(req.body.motivo_desabilitacao || '').trim();
    if (!ativo && !motivo) {
        return res.status(400).json({ error: 'Informe o motivo ao desabilitar o EJC.' });
    }

    try {
        await ensureTenantStructure();
        const [result] = await pool.query(
            `UPDATE tenants_ejc
             SET ativo = ?,
                 motivo_desabilitacao = ?,
                 desabilitado_em = ?
             WHERE id = ?`,
            [ativo ? 1 : 0, ativo ? null : motivo, ativo ? null : new Date(), tenantId]
        );
        if (!result.affectedRows) {
            return res.status(404).json({ error: 'EJC não encontrado.' });
        }
        await pool.query('UPDATE tenant_admin_users SET ativo = ? WHERE tenant_id = ?', [ativo ? 1 : 0, tenantId]);
        return res.json({ message: ativo ? 'EJC habilitado com sucesso.' : 'EJC desabilitado com sucesso.' });
    } catch (err) {
        console.error('Erro ao alterar status do tenant:', err);
        return res.status(500).json({ error: 'Erro ao alterar status do EJC.' });
    }
});

router.delete('/tenants/:id', requireAdmin, async (req, res) => {
    const tenantId = Number(req.params.id);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ error: 'Tenant inválido.' });
    }
    if (tenantId === 1) {
        return res.status(400).json({ error: 'O tenant principal (ID 1) não pode ser excluído.' });
    }

    const connection = await pool.getConnection();
    let foreignKeyChecksDisabled = false;
    try {
        await ensureAdminFeatureStructure();
        await connection.beginTransaction();

        const [[tenantRow]] = await connection.query(
            'SELECT id FROM tenants_ejc WHERE id = ? LIMIT 1',
            [tenantId]
        );
        if (!tenantRow) {
            await connection.rollback();
            return res.status(404).json({ error: 'EJC não encontrado.' });
        }

        await connection.query('DELETE FROM tenant_module_users WHERE tenant_id = ?', [tenantId]);
        await connection.query('DELETE FROM tenant_admin_users WHERE tenant_id = ?', [tenantId]);

        // Remove dados do tenant em qualquer tabela com coluna tenant_id para evitar falhas
        // quando novos módulos/tabelas forem adicionados.
        await connection.query('SET FOREIGN_KEY_CHECKS = 0');
        foreignKeyChecksDisabled = true;

        const scopedTables = await listTenantScopedTables(connection);
        for (const tableName of scopedTables) {
            const safeTableName = tableName.replace(/`/g, '``');
            await connection.query(`DELETE FROM \`${safeTableName}\` WHERE tenant_id = ?`, [tenantId]);
        }

        await connection.query('DELETE FROM tenants_ejc WHERE id = ?', [tenantId]);
        await connection.query('SET FOREIGN_KEY_CHECKS = 1');
        foreignKeyChecksDisabled = false;
        await connection.commit();
        return res.json({ message: 'EJC excluído com sucesso.' });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao excluir tenant:', err);
        return res.status(500).json({ error: 'Erro ao excluir EJC.' });
    } finally {
        if (foreignKeyChecksDisabled) {
            try {
                await connection.query('SET FOREIGN_KEY_CHECKS = 1');
            } catch (_err) {
                // noop
            }
        }
        connection.release();
    }
});

router.post('/tenants', requireAdmin, async (req, res) => {
    const nomeEjc = String(req.body.nome_ejc || req.body.paroquia || '').trim();
    const paroquia = String(req.body.paroquia || '').trim();
    const endereco = String(req.body.endereco || '').trim() || null;
    const cidade = String(req.body.cidade || '').trim();
    const estado = String(req.body.estado || '').trim();
    const username = normalizeEmail(req.body.username);
    const senha = String(req.body.senha || '');
    const nomeAdmin = String(req.body.nome_admin || 'Administrador do EJC').trim() || 'Administrador do EJC';
    const modules = normalizeModules(req.body.modules);
    const moduleUsers = normalizeModuleUsers(req.body.module_users);
    const adminUsername = normalizeUsername(req.body.admin_username);
    const adminNome = String(req.body.admin_nome || DEFAULT_PARISH_ADMIN_NAME).trim() || DEFAULT_PARISH_ADMIN_NAME;
    const adminSenha = String(req.body.admin_senha || '').trim();

    if (!paroquia || !cidade || !estado) {
        return res.status(400).json({ error: 'Preencha paróquia, cidade e estado.' });
    }
    if (!adminUsername || !adminSenha) {
        return res.status(400).json({ error: 'Informe usuário e senha do admin da paróquia.' });
    }

    const connection = await pool.getConnection();
    try {
        await ensureAdminFeatureStructure();
        await connection.beginTransaction();

        const [tenantResult] = await connection.query(
            'INSERT INTO tenants_ejc (nome_ejc, paroquia, endereco, cidade, estado, modules_json) VALUES (?, ?, ?, ?, ?, ?)',
            [nomeEjc, paroquia, endereco, cidade, estado, JSON.stringify(modules)]
        );
        const tenantId = tenantResult.insertId;

        await upsertTenantAdminUser(connection, {
            tenantId,
            username: adminUsername,
            nomeCompleto: adminNome,
            senha: adminSenha,
            ativo: true
        });

        if (username && senha) {
            await connection.query(
                'INSERT INTO usuarios (tenant_id, username, nome_completo, senha, grupo) VALUES (?, ?, ?, ?, ?)',
                [tenantId, username, nomeAdmin, hashPassword(senha), GRUPO_ADMIN_LOCAL]
            );
        }

        for (const moduleUser of moduleUsers) {
            if (!modules.includes(moduleUser.moduleCode)) continue;
            await connection.query(
                `INSERT INTO tenant_module_users
                 (tenant_id, module_code, nome_completo, email, senha_hash, grupo, ativo)
                 VALUES (?, ?, ?, ?, ?, ?, 1)`,
                [
                    tenantId,
                    moduleUser.moduleCode,
                    moduleUser.nomeCompleto,
                    moduleUser.email,
                    hashPassword(moduleUser.senha),
                    moduleUser.grupo
                ]
            );
            if (moduleUser.moduleCode === 'semear-jovens') {
                await syncLocalSemearJovensUser(connection, {
                    tenantId,
                    nomeCompleto: moduleUser.nomeCompleto,
                    email: moduleUser.email,
                    senha: moduleUser.senha,
                    grupo: moduleUser.grupo
                });
            }
        }

        await connection.commit();
        return res.json({ id: tenantId, message: 'EJC cadastrado com sucesso.' });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao cadastrar tenant:', err);
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Já existe EJC com esses dados ou usuário/e-mail já em uso.' });
        }
        return res.status(500).json({ error: 'Erro ao cadastrar EJC.' });
    } finally {
        connection.release();
    }
});

router.get('/tenants/:id/module-users', requireAdmin, async (req, res) => {
    const tenantId = Number(req.params.id);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ error: 'Tenant inválido.' });
    }
    const moduleCode = normalizeModuleCode(req.query.module_code);

    try {
        await ensureAdminFeatureStructure();
        let query = `
            SELECT id, tenant_id, module_code, nome_completo, email, grupo, ativo, created_at, updated_at
            FROM tenant_module_users
            WHERE tenant_id = ? AND ativo = 1
        `;
        const params = [tenantId];
        if (moduleCode) {
            query += ' AND module_code = ?';
            params.push(moduleCode);
        }
        query += ' ORDER BY module_code ASC, nome_completo ASC';
        const [rows] = await pool.query(query, params);
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar usuários por módulo:', err);
        return res.status(500).json({ error: 'Erro ao listar usuários por módulo.' });
    }
});

router.post('/tenants/:id/module-users', requireAdmin, async (req, res) => {
    const tenantId = Number(req.params.id);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ error: 'Tenant inválido.' });
    }
    const moduleCode = normalizeModuleCode(req.body.module_code);
    const nomeCompleto = String(req.body.nome_completo || '').trim();
    const email = normalizeEmail(req.body.email);
    const senha = String(req.body.senha || '');
    const grupo = normalizeGrupoLocal(req.body.grupo || GRUPO_ADMIN_LOCAL);

    if (!moduleCode || !MODULE_CODES.has(moduleCode)) {
        return res.status(400).json({ error: 'Módulo inválido.' });
    }
    if (!nomeCompleto || !email || !senha) {
        return res.status(400).json({ error: 'Preencha nome completo, e-mail e senha.' });
    }

    const connection = await pool.getConnection();
    try {
        await ensureAdminFeatureStructure();
        await connection.beginTransaction();

        const [[tenant]] = await connection.query(
            'SELECT id, modules_json FROM tenants_ejc WHERE id = ? LIMIT 1',
            [tenantId]
        );
        if (!tenant) {
            await connection.rollback();
            return res.status(404).json({ error: 'EJC não encontrado.' });
        }
        const modules = parseModulesJson(tenant.modules_json);
        if (!modules.includes(moduleCode)) {
            await connection.rollback();
            return res.status(400).json({ error: 'Este módulo não está habilitado para a paróquia.' });
        }

        const [insertResult] = await connection.query(
            `INSERT INTO tenant_module_users
             (tenant_id, module_code, nome_completo, email, senha_hash, grupo, ativo)
             VALUES (?, ?, ?, ?, ?, ?, 1)
             ON DUPLICATE KEY UPDATE
                 nome_completo = VALUES(nome_completo),
                 senha_hash = VALUES(senha_hash),
                 grupo = VALUES(grupo),
                 ativo = 1`,
            [tenantId, moduleCode, nomeCompleto, email, hashPassword(senha), grupo]
        );

        if (moduleCode === 'semear-jovens') {
            await syncLocalSemearJovensUser(connection, {
                tenantId,
                nomeCompleto,
                email,
                senha,
                grupo
            });
        }

        await connection.commit();
        return res.status(201).json({ id: insertResult.insertId || null, message: 'Usuário do módulo salvo com sucesso.' });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao salvar usuário por módulo:', err);
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Já existe usuário com este e-mail neste módulo.' });
        }
        return res.status(500).json({ error: 'Erro ao salvar usuário por módulo.' });
    } finally {
        connection.release();
    }
});

router.delete('/tenants/:tenantId/module-users/:userId', requireAdmin, async (req, res) => {
    const tenantId = Number(req.params.tenantId);
    const userId = Number(req.params.userId);
    if (!Number.isInteger(tenantId) || tenantId <= 0 || !Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: 'Parâmetros inválidos.' });
    }

    try {
        await ensureAdminFeatureStructure();
        const [result] = await pool.query(
            'DELETE FROM tenant_module_users WHERE id = ? AND tenant_id = ?',
            [userId, tenantId]
        );
        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Usuário não encontrado neste tenant.' });
        }
        return res.json({ message: 'Usuário do módulo removido com sucesso.' });
    } catch (err) {
        console.error('Erro ao remover usuário por módulo:', err);
        return res.status(500).json({ error: 'Erro ao remover usuário por módulo.' });
    }
});

module.exports = router;
