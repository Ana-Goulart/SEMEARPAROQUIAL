const express = require('express');
const { pool } = require('../database');
const { ensureStructure, hashPassword } = require('../lib/setup');

const router = express.Router();

function requireAdmin(req, res, next) {
    if (!req.admin || !req.admin.id || !req.admin.tenant_id) {
        return res.status(401).json({ error: 'Não autenticado.' });
    }
    return next();
}

function normalizeUsername(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeBool(value) {
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === '1' || value === 'true') return true;
    if (value === 0 || value === '0' || value === 'false') return false;
    return true;
}

router.get('/', requireAdmin, async (req, res) => {
    try {
        await ensureStructure();
        const tenantId = Number(req.admin.tenant_id);
        const [rows] = await pool.query(
            `SELECT id, tenant_id, username, nome_completo, ativo, created_at, updated_at
             FROM tenant_admin_users
             WHERE tenant_id = ?
             ORDER BY ativo DESC, nome_completo ASC, id ASC`,
            [tenantId]
        );
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar usuários do sistema da paróquia:', err);
        return res.status(500).json({ error: 'Erro ao listar usuários do sistema.' });
    }
});

router.post('/', requireAdmin, async (req, res) => {
    const tenantId = Number(req.admin.tenant_id);
    const username = normalizeUsername(req.body.username);
    const nomeCompleto = String(req.body.nome_completo || '').trim();
    const senha = String(req.body.senha || '');
    const ativo = normalizeBool(req.body.ativo);

    if (!username || !nomeCompleto || !senha) {
        return res.status(400).json({ error: 'Preencha nome completo, login e senha.' });
    }

    try {
        await ensureStructure();
        await pool.query(
            `INSERT INTO tenant_admin_users (tenant_id, username, nome_completo, senha_hash, ativo)
             VALUES (?, ?, ?, ?, ?)`,
            [tenantId, username, nomeCompleto, hashPassword(senha), ativo ? 1 : 0]
        );
        return res.status(201).json({ message: 'Usuário do sistema criado com sucesso.' });
    } catch (err) {
        console.error('Erro ao criar usuário do sistema da paróquia:', err);
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Já existe um usuário com este login.' });
        }
        return res.status(500).json({ error: 'Erro ao criar usuário do sistema.' });
    }
});

router.put('/:id', requireAdmin, async (req, res) => {
    const tenantId = Number(req.admin.tenant_id);
    const userId = Number(req.params.id);
    const username = normalizeUsername(req.body.username);
    const nomeCompleto = String(req.body.nome_completo || '').trim();
    const senha = String(req.body.senha || '');
    const ativo = normalizeBool(req.body.ativo);

    if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: 'Parâmetro inválido.' });
    }
    if (!username || !nomeCompleto) {
        return res.status(400).json({ error: 'Preencha nome completo e login.' });
    }

    try {
        await ensureStructure();
        let query = 'UPDATE tenant_admin_users SET username = ?, nome_completo = ?, ativo = ?';
        const params = [username, nomeCompleto, ativo ? 1 : 0];
        if (senha) {
            query += ', senha_hash = ?';
            params.push(hashPassword(senha));
        }
        query += ' WHERE id = ? AND tenant_id = ?';
        params.push(userId, tenantId);

        const [result] = await pool.query(query, params);
        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Usuário do sistema não encontrado.' });
        }
        return res.json({ message: 'Usuário do sistema atualizado com sucesso.' });
    } catch (err) {
        console.error('Erro ao atualizar usuário do sistema da paróquia:', err);
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Já existe um usuário com este login.' });
        }
        return res.status(500).json({ error: 'Erro ao atualizar usuário do sistema.' });
    }
});

router.delete('/:id', requireAdmin, async (req, res) => {
    const tenantId = Number(req.admin.tenant_id);
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: 'Parâmetro inválido.' });
    }

    try {
        await ensureStructure();
        const [result] = await pool.query(
            'DELETE FROM tenant_admin_users WHERE id = ? AND tenant_id = ?',
            [userId, tenantId]
        );
        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Usuário do sistema não encontrado.' });
        }
        return res.json({ message: 'Usuário do sistema removido com sucesso.' });
    } catch (err) {
        console.error('Erro ao excluir usuário do sistema da paróquia:', err);
        return res.status(500).json({ error: 'Erro ao excluir usuário do sistema.' });
    }
});

module.exports = router;
