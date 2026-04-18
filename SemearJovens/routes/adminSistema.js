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
    { code: 'semear-jovens', nome: 'EJC' }
];
const MODULE_CODES = new Set(MODULE_DEFINITIONS.map((item) => item.code));

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
}

async function syncLocalSemearJovensUser(connection, { tenantId, nomeCompleto, email, senha, grupo }) {
    const username = normalizeEmail(email);
    if (!username) return;

    const grupoSeguro = normalizeGrupoLocal(grupo);
    const [rows] = await connection.query(
        'SELECT id FROM usuarios WHERE tenant_id = ? ORDER BY id ASC LIMIT 1',
        [tenantId]
    );
    if (rows.length) {
        let query = 'UPDATE usuarios SET username = ?, nome_completo = ?, grupo = ?';
        const params = [username, String(nomeCompleto || '').trim(), grupoSeguro];
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

router.get('/tenants', requireAdmin, async (_req, res) => {
    try {
        await ensureAdminFeatureStructure();
        const [rows] = await pool.query(`
            SELECT t.*,
                   u.id AS usuario_id,
                   u.username AS usuario_username
            FROM tenants_ejc t
            LEFT JOIN usuarios u ON u.id = (
                SELECT ux.id
                FROM usuarios ux
                WHERE ux.tenant_id = t.id
                ORDER BY ux.id ASC
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

    const nomeEjc = String(req.body.nome_ejc || '').trim();
    const paroquia = String(req.body.paroquia || '').trim();
    const endereco = String(req.body.endereco || '').trim() || null;
    const cidade = String(req.body.cidade || '').trim();
    const estado = String(req.body.estado || '').trim();
    const modules = ['semear-jovens'];

    if (!nomeEjc || !paroquia || !cidade || !estado) {
        return res.status(400).json({ error: 'Preencha nome do EJC, paróquia, cidade e estado.' });
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

        return res.json({ message: 'EJC atualizado com sucesso.' });
    } catch (err) {
        console.error('Erro ao atualizar tenant:', err);
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
    const nomeEjc = String(req.body.nome_ejc || '').trim();
    const paroquia = String(req.body.paroquia || '').trim();
    const endereco = String(req.body.endereco || '').trim() || null;
    const cidade = String(req.body.cidade || '').trim();
    const estado = String(req.body.estado || '').trim();
    const username = normalizeEmail(req.body.username);
    const senha = String(req.body.senha || '');
    const nomeAdmin = String(req.body.nome_admin || 'Administrador do EJC').trim() || 'Administrador do EJC';
    const modules = ['semear-jovens'];
    const moduleUsers = normalizeModuleUsers(req.body.module_users)
        .filter((item) => item.moduleCode === 'semear-jovens')
        .slice(0, 1);

    if (!nomeEjc || !paroquia || !cidade || !estado) {
        return res.status(400).json({ error: 'Preencha nome do EJC, paróquia, cidade e estado.' });
    }

    if (!moduleUsers.length) {
        return res.status(400).json({ error: 'Informe o usuário inicial do EJC.' });
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

    if (!moduleCode || !MODULE_CODES.has(moduleCode) || moduleCode !== 'semear-jovens') {
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

        const [[existingUser]] = await connection.query(
            `SELECT id
             FROM tenant_module_users
             WHERE tenant_id = ? AND module_code = ? AND ativo = 1
             ORDER BY id ASC
             LIMIT 1`,
            [tenantId, moduleCode]
        );

        let insertResult = { insertId: null };
        if (existingUser && existingUser.id) {
            await connection.query(
                `UPDATE tenant_module_users
                 SET nome_completo = ?, email = ?, senha_hash = ?, grupo = ?, ativo = 1
                 WHERE id = ? AND tenant_id = ?`,
                [nomeCompleto, email, hashPassword(senha), grupo, existingUser.id, tenantId]
            );
            insertResult = { insertId: existingUser.id };
        } else {
            const [created] = await connection.query(
                `INSERT INTO tenant_module_users
                 (tenant_id, module_code, nome_completo, email, senha_hash, grupo, ativo)
                 VALUES (?, ?, ?, ?, ?, ?, 1)`,
                [tenantId, moduleCode, nomeCompleto, email, hashPassword(senha), grupo]
            );
            insertResult = created;
        }

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
        const [[currentUser]] = await pool.query(
            'SELECT module_code FROM tenant_module_users WHERE id = ? AND tenant_id = ? LIMIT 1',
            [userId, tenantId]
        );
        if (!currentUser) {
            return res.status(404).json({ error: 'Usuário não encontrado neste tenant.' });
        }
        if (currentUser.module_code === 'semear-jovens') {
            return res.status(400).json({ error: 'O painel da paróquia deve manter exatamente um usuário do EJC.' });
        }
        const [result] = await pool.query(
            'DELETE FROM tenant_module_users WHERE id = ? AND tenant_id = ?',
            [userId, tenantId]
        );
        return res.json({ message: 'Usuário do módulo removido com sucesso.' });
    } catch (err) {
        console.error('Erro ao remover usuário por módulo:', err);
        return res.status(500).json({ error: 'Erro ao remover usuário por módulo.' });
    }
});

module.exports = router;
