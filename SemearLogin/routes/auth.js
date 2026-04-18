const express = require('express');
const crypto = require('crypto');
const { pool, corePool } = require('../database');
const { setSessionCookie, clearSessionCookie } = require('../lib/authSession');

const router = express.Router();

function hashPassword(password) {
    return crypto.createHash('sha256').update(String(password || '')).digest('hex');
}

function resolveNextUrl(rawNext) {
    const fallback = String(process.env.DEFAULT_AFTER_LOGIN_URL || 'https://ejc.semearparoquial.com.br/dashboard').trim();
    const value = String(rawNext || '').trim();
    if (!value) return fallback;
    if (!/^https?:\/\//i.test(value)) return fallback;
    return value;
}

function resolveAuthorizedNextUrl(rawNext, allowedBaseUrl) {
    const candidate = String(rawNext || '').trim();
    const allowed = String(allowedBaseUrl || '').trim();
    if (!candidate || !allowed) return '';

    try {
        const candidateUrl = new URL(candidate);
        const allowedUrl = new URL(allowed);
        if (candidateUrl.hostname.toLowerCase() !== allowedUrl.hostname.toLowerCase()) {
            return '';
        }
        return candidate;
    } catch (_) {
        return '';
    }
}

function buildSystemRedirectUrl(row) {
    const defaultUrl = resolveNextUrl('');
    if (!row) return defaultUrl;
    const domain = String(row.domain || '').trim();
    if (!domain) return defaultUrl;

    const protocol = String(process.env.SYSTEM_REDIRECT_PROTOCOL || 'http').trim().toLowerCase() === 'https'
        ? 'https'
        : 'http';
    const withProtocol = /^https?:\/\//i.test(domain) ? domain : `${protocol}://${domain}`;
    return `${withProtocol.replace(/\/+$/, '')}/dashboard`;
}

async function resolveCorePasswordAccess(username, passwordHash) {
    const login = String(username || '').trim().toLowerCase();
    if (!login || !passwordHash) return null;

    const [rows] = await corePool.query(
        `SELECT
            u.id AS user_id,
            u.legacy_source,
            u.legacy_user_id,
            u.password_hash_legacy,
            s.id AS system_id,
            s.code AS system_code,
            s.domain AS domain
         FROM users u
         JOIN user_access ua ON ua.user_id = u.id
         JOIN systems s ON s.id = ua.system_id
         LEFT JOIN parishes p ON p.id = ua.parish_id
         WHERE u.active = 1
           AND ua.active = 1
           AND s.active = 1
           AND (p.id IS NULL OR p.active = 1)
           AND LOWER(u.email) = LOWER(?)`,
        [login]
    );

    const validRows = (rows || []).filter((row) => String(row.password_hash_legacy || '') === passwordHash);
    if (!validRows.length) return null;

    const uniqueSystems = new Map();
    for (const row of validRows) {
        const key = `${row.system_id}:${String(row.domain || '').toLowerCase()}`;
        if (!uniqueSystems.has(key)) uniqueSystems.set(key, row);
    }

    const destinos = [...uniqueSystems.values()];
    if (!destinos.length) return null;
    if (destinos.length > 1) return { multiSystem: true };

    const selected = destinos[0];
    let sessionUserId = Number(selected.user_id);
    const legacySource = String(selected.legacy_source || '').trim().toLowerCase();
    const legacyUserId = Number(selected.legacy_user_id || 0);
    const systemCode = String(selected.system_code || '').trim().toLowerCase();

    if (systemCode === 'semear-jovens' && legacySource === 'db_semeajovens' && legacyUserId > 0) {
        sessionUserId = legacyUserId;
    }

    return {
        multiSystem: false,
        userId: Number(selected.user_id),
        sessionUserId,
        redirectTo: buildSystemRedirectUrl(selected)
    };
}

router.get('/me', async (req, res) => {
    try {
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
        const tenantId = Number(req.body.tenant_id || 0);
        const username = String(req.body.username || '').trim();
        const senha = String(req.body.senha || '');
        const next = resolveNextUrl(req.body.next || req.query.next);

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

            if (!matchRows.length) return res.status(401).json({ error: 'Credenciais inválidas.' });
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

        try {
            const coreResult = await resolveCorePasswordAccess(username, hash);
            if (coreResult && coreResult.multiSystem) {
                return res.status(409).json({
                    error: 'Este usuário possui acesso a mais de um módulo. Informe o link direto do sistema desejado.'
                });
            }
            if (coreResult && coreResult.userId) {
                setSessionCookie(res, coreResult.sessionUserId || coreResult.userId);
                const safeNext = resolveAuthorizedNextUrl(req.body.next || req.query.next, coreResult.redirectTo);
                return res.json({
                    message: 'Login efetuado com sucesso.',
                    redirect_to: safeNext || coreResult.redirectTo || next,
                    user: { id: user.id, username: user.username, nome_completo: user.nome_completo, grupo: user.grupo }
                });
            }
        } catch (coreErr) {
            console.error('Falha ao resolver redirecionamento central do login:', coreErr);
        }

        setSessionCookie(res, user.id);
        return res.json({
            message: 'Login efetuado com sucesso.',
            redirect_to: next,
            user: { id: user.id, username: user.username, nome_completo: user.nome_completo, grupo: user.grupo }
        });
    } catch (err) {
        console.error('Erro no login:', err);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

router.post('/logout', (_req, res) => {
    clearSessionCookie(res);
    res.json({ message: 'Logout efetuado.' });
});

module.exports = router;
