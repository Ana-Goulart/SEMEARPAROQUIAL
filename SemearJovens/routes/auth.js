const express = require('express');
const crypto = require('crypto');
const { pool } = require('../database');
const { setSessionCookie, clearSessionCookie } = require('../lib/authSession');
const { purgeExpiredUsers } = require('../lib/usuariosExpiracao');
const { ensureTenantStructure } = require('../lib/tenantSetup');

const router = express.Router();

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

router.get('/me', async (req, res) => {
    try {
        await ensureTenantStructure();
        await purgeExpiredUsers();
        if (!req.user || !req.user.id) return res.json({ logged: false });
        const [rows] = await pool.query(
            `SELECT u.id, u.username, u.nome_completo, u.grupo, u.tenant_id,
                    t.nome_ejc, t.cidade, t.estado
             FROM usuarios u
             LEFT JOIN tenants_ejc t ON t.id = u.tenant_id
             WHERE u.id = ?
             LIMIT 1`,
            [req.user.id]
        );
        if (!rows.length) return res.json({ logged: false });
        return res.json({ logged: true, user: rows[0] });
    } catch (err) {
        console.error('Erro ao obter sessão:', err);
        return res.status(500).json({ error: 'Erro ao obter sessão.' });
    }
});

router.post('/login', async (req, res) => {
    try {
        await ensureTenantStructure();
        await purgeExpiredUsers();
        const tenantId = Number(req.body.tenant_id || 0);
        const username = String(req.body.username || '').trim();
        const senha = String(req.body.senha || '');
        if (!username || !senha) {
            return res.status(400).json({ error: 'Informe usuário e senha.' });
        }

        let resolvedTenantId = tenantId;
        if (!resolvedTenantId) {
            const [matchRows] = await pool.query(
                `SELECT u.tenant_id
                 FROM usuarios u
                 JOIN tenants_ejc t ON t.id = u.tenant_id
                 WHERE u.username = ? AND t.ativo = 1`,
                [username]
            );

            if (!matchRows.length) {
                return res.status(401).json({ error: 'Credenciais inválidas.' });
            }
            const tenantIds = [...new Set(matchRows.map((row) => Number(row.tenant_id)).filter(Boolean))];
            if (tenantIds.length > 1) {
                return res.status(409).json({
                    error: 'Não foi possível identificar o EJC deste usuário. Contate o administrador.'
                });
            }
            resolvedTenantId = tenantIds[0];
        }

        const [tenantRows] = await pool.query(
            'SELECT id, ativo, motivo_desabilitacao FROM tenants_ejc WHERE id = ? LIMIT 1',
            [resolvedTenantId]
        );
        if (!tenantRows.length) return res.status(400).json({ error: 'EJC não encontrado.' });
        if (!tenantRows[0].ativo) {
            return res.status(403).json({
                error: 'Este EJC está desabilitado no momento.',
                motivo: tenantRows[0].motivo_desabilitacao || null
            });
        }

        const [rows] = await pool.query(
            `SELECT u.id, u.username, u.nome_completo, u.grupo, u.senha, u.tenant_id
             FROM usuarios u
             JOIN tenants_ejc t ON t.id = u.tenant_id
             WHERE u.username = ? AND u.tenant_id = ?
             LIMIT 1`,
            [username, resolvedTenantId]
        );
        if (!rows.length) return res.status(401).json({ error: 'Credenciais inválidas.' });

        const user = rows[0];
        const hash = hashPassword(senha);
        if (hash !== user.senha) return res.status(401).json({ error: 'Credenciais inválidas.' });

        setSessionCookie(res, user.id);
        return res.json({
            message: 'Login efetuado com sucesso.',
            user: { id: user.id, username: user.username, nome_completo: user.nome_completo, grupo: user.grupo }
        });
    } catch (err) {
        console.error('Erro no login:', err);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

router.get('/tenants', async (_req, res) => {
    try {
        await ensureTenantStructure();
        const [rows] = await pool.query(`
            SELECT id, nome_ejc, cidade, estado, ativo, motivo_desabilitacao
            FROM tenants_ejc
            ORDER BY estado ASC, cidade ASC, nome_ejc ASC
        `);
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar tenants no login:', err);
        return res.status(500).json({ error: 'Erro ao carregar lista de EJCs.' });
    }
});

router.post('/logout', (_req, res) => {
    clearSessionCookie(res);
    res.json({ message: 'Logout efetuado.' });
});

module.exports = router;
