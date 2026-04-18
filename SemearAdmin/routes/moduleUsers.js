const express = require('express');
const { pool } = require('../database');
const { ensureStructure, hashPassword } = require('../lib/setup');

const router = express.Router();
const GRUPO_ADMIN_LOCAL = 'Tios';
const GRUPOS_VALIDOS_SEMEAR_JOVENS = new Set(['Tios', 'Jovens', 'Diretor Espiritual', 'Padre']);
const MODULE_DEFINITIONS = [
    { code: 'semear-jovens', nome: 'EJC' }
];
const MODULE_CODES = new Set(MODULE_DEFINITIONS.map((item) => item.code));

function requireAdmin(req, res, next) {
    if (!req.admin || !req.admin.id || !req.admin.tenant_id) {
        return res.status(401).json({ error: 'Não autenticado.' });
    }
    return next();
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
        return parsed.map((item) => normalizeModuleCode(item)).filter((item) => MODULE_CODES.has(item));
    } catch (_) {
        return [];
    }
}

async function keepSingleEjcUser(connection, tenantId) {
    const [rows] = await connection.query(
        `SELECT id
         FROM tenant_module_users
         WHERE tenant_id = ? AND module_code = 'semear-jovens' AND ativo = 1
         ORDER BY id ASC`,
        [tenantId]
    );
    if (!Array.isArray(rows) || rows.length <= 1) {
        return rows && rows[0] ? Number(rows[0].id) : null;
    }
    const keepId = Number(rows[0].id);
    const removeIds = rows.slice(1).map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0);
    if (removeIds.length) {
        await connection.query(
            `DELETE FROM tenant_module_users
             WHERE tenant_id = ? AND module_code = 'semear-jovens' AND id IN (${removeIds.map(() => '?').join(',')})`,
            [tenantId, ...removeIds]
        );
    }
    return keepId;
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

router.get('/modules', requireAdmin, async (_req, res) => {
    await ensureStructure();
    return res.json(MODULE_DEFINITIONS);
});

router.get('/', requireAdmin, async (req, res) => {
    try {
        await ensureStructure();
        const tenantId = Number(req.admin.tenant_id);
        const moduleCode = normalizeModuleCode(req.query.module_code);
        await keepSingleEjcUser(pool, tenantId);

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
        return res.status(500).json({ error: 'Erro ao listar usuários.' });
    }
});

router.post('/', requireAdmin, async (req, res) => {
    const tenantId = Number(req.admin.tenant_id);
    const moduleCode = normalizeModuleCode(req.body.module_code);
    const nomeCompleto = String(req.body.nome_completo || '').trim();
    const email = normalizeEmail(req.body.email);
    const senha = String(req.body.senha || '');
    const grupo = normalizeGrupoLocal(req.body.grupo || GRUPO_ADMIN_LOCAL);

    if (!moduleCode || !MODULE_CODES.has(moduleCode) || moduleCode !== 'semear-jovens') {
        return res.status(400).json({ error: 'A paróquia pode cadastrar apenas um usuário do EJC.' });
    }
    if (!nomeCompleto || !email || !senha) return res.status(400).json({ error: 'Preencha nome completo, e-mail e senha.' });

    const connection = await pool.getConnection();
    try {
        await ensureStructure();
        await connection.beginTransaction();

        const [[tenant]] = await connection.query(
            'SELECT id, modules_json FROM tenants_ejc WHERE id = ? AND ativo = 1 LIMIT 1',
            [tenantId]
        );
        if (!tenant) {
            await connection.rollback();
            return res.status(404).json({ error: 'Paróquia não encontrada.' });
        }

        const modules = parseModulesJson(tenant.modules_json);
        if (!modules.includes(moduleCode)) {
            await connection.rollback();
            return res.status(400).json({ error: 'Este módulo não está habilitado para a sua paróquia.' });
        }

        const [[existingUser]] = await connection.query(
            `SELECT id
             FROM tenant_module_users
             WHERE tenant_id = ? AND module_code = ? AND ativo = 1
             ORDER BY id ASC
             LIMIT 1`,
            [tenantId, moduleCode]
        );

        if (existingUser && existingUser.id) {
            await connection.query(
                `UPDATE tenant_module_users
                 SET nome_completo = ?, email = ?, senha_hash = ?, grupo = ?, ativo = 1
                 WHERE id = ? AND tenant_id = ?`,
                [nomeCompleto, email, hashPassword(senha), grupo, existingUser.id, tenantId]
            );
        } else {
            await connection.query(
                `INSERT INTO tenant_module_users
                 (tenant_id, module_code, nome_completo, email, senha_hash, grupo, ativo)
                 VALUES (?, ?, ?, ?, ?, ?, 1)`,
                [tenantId, moduleCode, nomeCompleto, email, hashPassword(senha), grupo]
            );
        }
        await keepSingleEjcUser(connection, tenantId);

        if (moduleCode === 'semear-jovens') {
            await syncLocalSemearJovensUser(connection, {
                tenantId,
                nomeCompleto,
                email,
                senha,
                grupo
            });
            await connection.query(
                'UPDATE tenants_ejc SET nome_ejc = ? WHERE id = ?',
                [nomeCompleto, tenantId]
            );
        }

        await connection.commit();
        return res.status(201).json({ message: 'Usuário do módulo salvo com sucesso.' });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao salvar usuário do módulo:', err);
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Já existe usuário com este e-mail neste módulo.' });
        }
        return res.status(500).json({ error: 'Erro ao salvar usuário do módulo.' });
    } finally {
        connection.release();
    }
});

router.delete('/:id', requireAdmin, async (req, res) => {
    const tenantId = Number(req.admin.tenant_id);
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'Parâmetro inválido.' });

    try {
        await ensureStructure();
        return res.status(400).json({ error: 'A paróquia deve manter exatamente um único usuário do EJC.' });
    } catch (err) {
        console.error('Erro ao remover usuário de módulo:', err);
        return res.status(500).json({ error: 'Erro ao remover usuário.' });
    }
});

module.exports = router;
