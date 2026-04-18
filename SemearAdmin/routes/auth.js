const express = require('express');
const { pool } = require('../database');
const { ensureStructure, hashPassword } = require('../lib/setup');
const { setAdminSessionCookie, clearAdminSessionCookie } = require('../lib/authSession');

const router = express.Router();

function requireAdmin(req, res, next) {
    if (!req.admin || !req.admin.id || !req.admin.tenant_id) {
        return res.status(401).json({ error: 'Não autenticado.' });
    }
    return next();
}

router.get('/me', async (req, res) => {
    try {
        await ensureStructure();
        if (!req.admin || !req.admin.id || !req.admin.tenant_id) return res.json({ logged: false });
        const [rows] = await pool.query(
            `SELECT ta.id, ta.username, ta.nome_completo, ta.tenant_id, ta.ativo,
                    t.nome_ejc, t.paroquia, t.ativo AS tenant_ativo
             FROM tenant_admin_users ta
             JOIN tenants_ejc t ON t.id = ta.tenant_id
             WHERE ta.id = ? AND ta.tenant_id = ?
             LIMIT 1`,
            [req.admin.id, req.admin.tenant_id]
        );
        if (!rows.length) return res.json({ logged: false });
        const admin = rows[0];
        if (!admin.ativo || !admin.tenant_ativo) return res.json({ logged: false });
        return res.json({ logged: true, user: admin });
    } catch (err) {
        console.error('Erro ao obter sessão admin da paróquia:', err);
        return res.status(500).json({ error: 'Erro ao obter sessão.' });
    }
});

router.post('/login', async (req, res) => {
    try {
        await ensureStructure();
        const username = String(req.body.username || '').trim().toLowerCase();
        const senha = String(req.body.senha || '');
        if (!username || !senha) return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });

        const [rows] = await pool.query(
            `SELECT ta.id, ta.tenant_id, ta.username, ta.nome_completo, ta.senha_hash, ta.ativo,
                    t.ativo AS tenant_ativo
             FROM tenant_admin_users ta
             JOIN tenants_ejc t ON t.id = ta.tenant_id
             WHERE ta.username = ?
             LIMIT 1`,
            [username]
        );

        if (!rows.length) return res.status(401).json({ error: 'Credenciais inválidas.' });
        const admin = rows[0];
        if (!admin.ativo || !admin.tenant_ativo) return res.status(403).json({ error: 'Conta desabilitada.' });
        if (admin.senha_hash !== hashPassword(senha)) return res.status(401).json({ error: 'Credenciais inválidas.' });

        setAdminSessionCookie(res, admin.id, admin.tenant_id);
        return res.json({
            message: 'Login efetuado com sucesso.',
            user: {
                id: admin.id,
                tenant_id: admin.tenant_id,
                username: admin.username,
                nome_completo: admin.nome_completo
            }
        });
    } catch (err) {
        console.error('Erro no login do admin da paróquia:', err);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

router.post('/logout', (_req, res) => {
    clearAdminSessionCookie(res);
    return res.json({ message: 'Logout efetuado.' });
});

router.get('/tenant', requireAdmin, async (req, res) => {
    try {
        await ensureStructure();
        const [rows] = await pool.query(
            'SELECT id, nome_ejc, paroquia, cidade, estado, modules_json FROM tenants_ejc WHERE id = ? LIMIT 1',
            [req.admin.tenant_id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Paróquia não encontrada.' });

        let modules = [];
        try {
            const parsed = JSON.parse(rows[0].modules_json || '[]');
            modules = Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            modules = [];
        }

        return res.json({ ...rows[0], modules });
    } catch (err) {
        console.error('Erro ao carregar tenant do admin:', err);
        return res.status(500).json({ error: 'Erro ao carregar paróquia.' });
    }
});

router.put('/tenant', requireAdmin, async (req, res) => {
    try {
        await ensureStructure();
        const nomeEjc = String(req.body && req.body.nome_ejc ? req.body.nome_ejc : '').trim();
        if (!nomeEjc) return res.status(400).json({ error: 'Informe o nome do EJC.' });

        const [result] = await pool.query(
            'UPDATE tenants_ejc SET nome_ejc = ? WHERE id = ?',
            [nomeEjc, req.admin.tenant_id]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Paróquia não encontrada.' });

        return res.json({ message: 'Nome do EJC atualizado com sucesso.', nome_ejc: nomeEjc });
    } catch (err) {
        console.error('Erro ao atualizar nome do EJC:', err);
        return res.status(500).json({ error: 'Erro ao atualizar nome do EJC.' });
    }
});

module.exports = router;
