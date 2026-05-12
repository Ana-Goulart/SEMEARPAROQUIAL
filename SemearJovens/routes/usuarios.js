const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const bcrypt = require('bcrypt');
const { purgeExpiredUsers } = require('../lib/usuariosExpiracao');
const { getTenantId } = require('../lib/tenantIsolation');

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);
const GRUPOS_VALIDOS = new Set(['Tios', 'Jovens', 'Diretor Espiritual', 'Padre']);

async function hashPassword(password) {
    return bcrypt.hash(String(password || ''), BCRYPT_ROUNDS);
}

function normalizarGrupo(grupo) {
    const valor = String(grupo || '').trim();
    return GRUPOS_VALIDOS.has(valor) ? valor : null;
}

function normalizarIds(values) {
    if (!Array.isArray(values)) return [];
    return Array.from(new Set(
        values
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value > 0)
    ));
}

async function isManagedByParishAdmin(tenantId, email) {
    const tenant = Number(tenantId || 0);
    const loginEmail = String(email || '').trim().toLowerCase();
    if (!tenant || !loginEmail) return false;

    const [rows] = await pool.query(
        `SELECT id
         FROM tenant_module_users
         WHERE tenant_id = ?
           AND module_code = 'semear-jovens'
           AND ativo = 1
           AND LOWER(email) = LOWER(?)
         LIMIT 1`,
        [tenant, loginEmail]
    );
    return rows.length > 0;
}

async function sincronizarFuncoesDirigencia(connection, { tenantId, usuarioId, funcaoIds }) {
    const ids = normalizarIds(funcaoIds);
    await connection.query(
        'DELETE FROM funcoes_dirigencia_usuarios WHERE tenant_id = ? AND usuario_id = ?',
        [tenantId, usuarioId]
    );
    if (!ids.length) return;

    const [validas] = await connection.query(
        'SELECT id FROM funcoes_dirigencia WHERE tenant_id = ? AND id IN (?)',
        [tenantId, ids]
    );
    const idsValidas = (validas || []).map((row) => Number(row.id)).filter(Boolean);
    for (const funcaoId of idsValidas) {
        await connection.query(
            `INSERT INTO funcoes_dirigencia_usuarios (tenant_id, funcao_id, usuario_id)
             VALUES (?, ?, ?)`,
            [tenantId, funcaoId, usuarioId]
        );
    }
}

async function carregarFuncoesPorUsuario(tenantId, usuarioIds) {
    const ids = normalizarIds(usuarioIds);
    if (!ids.length) return new Map();
    const [rows] = await pool.query(
        `SELECT usuario_id, funcao_id
         FROM funcoes_dirigencia_usuarios
         WHERE tenant_id = ?
           AND usuario_id IN (?)`,
        [tenantId, ids]
    );
    const map = new Map();
    for (const row of (rows || [])) {
        const usuarioId = Number(row.usuario_id);
        const funcaoId = Number(row.funcao_id);
        if (!usuarioId || !funcaoId) continue;
        if (!map.has(usuarioId)) map.set(usuarioId, []);
        map.get(usuarioId).push(funcaoId);
    }
    return map;
}

router.get('/', async (req, res) => {
    try {
        await purgeExpiredUsers();
        const tenantId = getTenantId(req);
        const [rows] = await pool.query(
            `SELECT id, nome_completo, username, data_entrada, data_saida, grupo, jovem_id,
                    CASE WHEN data_saida IS NULL OR data_saida >= CURDATE() THEN 1 ELSE 0 END AS ativo
             FROM usuarios
             WHERE tenant_id = ?
             ORDER BY nome_completo ASC`,
            [tenantId]
        );

        const funcoesPorUsuario = await carregarFuncoesPorUsuario(tenantId, (rows || []).map((row) => row.id));
        let managedRows = [];
        try {
            const [adminRows] = await pool.query(
                `SELECT id, nome_completo, email, grupo, ativo, created_at
                 FROM tenant_module_users
                 WHERE tenant_id = ?
                   AND module_code = 'semear-jovens'
                   AND ativo = 1`,
                [tenantId]
            );
            managedRows = Array.isArray(adminRows) ? adminRows : [];
        } catch (_) {
            managedRows = [];
        }

        const emailsLocais = new Set(
            (rows || []).map((row) => String(row.username || '').trim().toLowerCase()).filter(Boolean)
        );

        const locais = (rows || []).map((row) => ({
            ...row,
            funcoes_dirigencia_ids: funcoesPorUsuario.get(Number(row.id)) || [],
            managed_by_parish_admin: managedRows.some((admin) => (
                String(admin.email || '').trim().toLowerCase() === String(row.username || '').trim().toLowerCase()
            ))
        }));

        const adminOnly = managedRows
            .filter((row) => {
                const email = String(row.email || '').trim().toLowerCase();
                return email && !emailsLocais.has(email);
            })
            .map((row) => ({
                id: `parish-admin-${row.id}`,
                nome_completo: row.nome_completo || 'Usuário do módulo EJC',
                username: row.email || '',
                data_entrada: row.created_at || null,
                data_saida: null,
                grupo: row.grupo || 'Tios',
                jovem_id: null,
                ativo: Number(row.ativo) === 1,
                funcoes_dirigencia_ids: [],
                managed_by_parish_admin: true
            }));

        return res.json([...locais, ...adminOnly]);
    } catch (err) {
        console.error('Erro ao listar usuários:', err);
        return res.status(500).json({ error: 'Erro ao listar usuários.' });
    }
});

router.post('/', async (req, res) => {
    let { username, nome_completo, senha, data_entrada, data_saida, grupo, jovem_id, funcoes_dirigencia_ids } = req.body;
    const tenantId = getTenantId(req);
    const grupoFinal = normalizarGrupo(grupo);
    const jovemIdNum = Number(jovem_id);
    const jovemId = Number.isInteger(jovemIdNum) && jovemIdNum > 0 ? jovemIdNum : null;

    if (jovemId) {
        const [jovensRes] = await pool.query(
            'SELECT nome_completo FROM jovens WHERE id = ? AND tenant_id = ? LIMIT 1',
            [jovemId, tenantId]
        );
        if (!jovensRes.length) return res.status(400).json({ error: 'Jovem não encontrado.' });
        nome_completo = jovensRes[0].nome_completo || nome_completo;
    }

    const login = String(username || '').trim().toLowerCase();
    const nome = String(nome_completo || '').trim();
    if (!login || !nome || !senha || !grupoFinal) {
        return res.status(400).json({ error: 'Campos obrigatórios faltando.' });
    }
    if (login.length > 50) {
        return res.status(400).json({ error: 'Login deve ter no máximo 50 caracteres.' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [insertResult] = await connection.query(
            `INSERT INTO usuarios
                (tenant_id, username, nome_completo, senha, data_entrada, data_saida, grupo, jovem_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                tenantId,
                login,
                nome,
                await hashPassword(senha),
                data_entrada || null,
                data_saida || null,
                grupoFinal,
                jovemId
            ]
        );
        const usuarioId = Number(insertResult.insertId);
        await sincronizarFuncoesDirigencia(connection, { tenantId, usuarioId, funcaoIds: funcoes_dirigencia_ids });
        await connection.commit();
        return res.json({ id: usuarioId, message: 'Usuário criado com sucesso.' });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao criar usuário:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Este login já existe neste EJC.' });
        }
        return res.status(500).json({ error: 'Erro ao criar usuário.' });
    } finally {
        connection.release();
    }
});

router.put('/:id', async (req, res) => {
    const usuarioId = Number(req.params.id);
    const { username, nome_completo, senha, data_entrada, data_saida, grupo, funcoes_dirigencia_ids } = req.body;
    const tenantId = getTenantId(req);
    const grupoFinal = normalizarGrupo(grupo);
    const login = String(username || '').trim().toLowerCase();
    const nome = String(nome_completo || '').trim();

    if (!Number.isInteger(usuarioId) || usuarioId <= 0) {
        return res.status(400).json({ error: 'ID de usuário inválido.' });
    }
    if (!login || !nome || !grupoFinal) {
        return res.status(400).json({ error: 'Campos obrigatórios faltando.' });
    }
    if (login.length > 50) {
        return res.status(400).json({ error: 'Login deve ter no máximo 50 caracteres.' });
    }
    if (await isManagedByParishAdmin(tenantId, login)) {
        return res.status(403).json({ error: 'Este usuário é gerenciado pelo painel da paróquia.' });
    }

    const connection = await pool.getConnection();
    try {
        const [exists] = await connection.query(
            'SELECT id FROM usuarios WHERE id = ? AND tenant_id = ? LIMIT 1',
            [usuarioId, tenantId]
        );
        if (!exists.length) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }

        await connection.beginTransaction();
        const updateData = {
            username: login,
            nome_completo: nome,
            data_entrada: data_entrada || null,
            data_saida: data_saida || null,
            grupo: grupoFinal
        };
        if (senha) updateData.senha = await hashPassword(senha);
        await connection.query(
            'UPDATE usuarios SET ? WHERE id = ? AND tenant_id = ?',
            [updateData, usuarioId, tenantId]
        );
        await sincronizarFuncoesDirigencia(connection, { tenantId, usuarioId, funcaoIds: funcoes_dirigencia_ids });
        await connection.commit();
        return res.json({ message: 'Usuário atualizado com sucesso.' });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao atualizar usuário:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Este login já existe neste EJC.' });
        }
        return res.status(500).json({ error: 'Erro ao atualizar usuário.' });
    } finally {
        connection.release();
    }
});

router.delete('/:id', async (req, res) => {
    const usuarioId = Number(req.params.id);
    const tenantId = getTenantId(req);
    if (!Number.isInteger(usuarioId) || usuarioId <= 0) {
        return res.status(400).json({ error: 'ID de usuário inválido.' });
    }

    const connection = await pool.getConnection();
    try {
        const [[userRow]] = await connection.query(
            'SELECT username FROM usuarios WHERE id = ? AND tenant_id = ? LIMIT 1',
            [usuarioId, tenantId]
        );
        if (!userRow) return res.status(404).json({ error: 'Usuário não encontrado.' });
        if (await isManagedByParishAdmin(tenantId, userRow.username)) {
            return res.status(403).json({ error: 'Este usuário é gerenciado pelo painel da paróquia.' });
        }

        await connection.beginTransaction();
        await connection.query(
            'DELETE FROM funcoes_dirigencia_usuarios WHERE tenant_id = ? AND usuario_id = ?',
            [tenantId, usuarioId]
        );
        const [result] = await connection.query(
            'DELETE FROM usuarios WHERE id = ? AND tenant_id = ?',
            [usuarioId, tenantId]
        );
        await connection.commit();
        if (!result.affectedRows) return res.status(404).json({ error: 'Usuário não encontrado.' });
        return res.json({ message: 'Usuário removido com sucesso.' });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao deletar usuário:', err);
        return res.status(500).json({ error: 'Erro ao deletar usuário.' });
    } finally {
        connection.release();
    }
});

module.exports = router;
