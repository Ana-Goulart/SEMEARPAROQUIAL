const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { pool } = require('../database');
const { setSessionCookie, clearSessionCookie } = require('../lib/authSession');
const { purgeExpiredUsers } = require('../lib/usuariosExpiracao');
const { ensureTenantStructure } = require('../lib/tenantSetup');

const router = express.Router();

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);
const CURRENT_RELEASE_NOTICE_VERSION = '1.1.0';

async function ensureReleaseNoticeTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS usuario_release_notices (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            usuario_id INT NOT NULL,
            release_version VARCHAR(30) NOT NULL,
            acknowledged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_usuario_release_notice (tenant_id, usuario_id, release_version),
            KEY idx_usuario_release_notices_usuario (tenant_id, usuario_id),
            KEY idx_usuario_release_notices_version (release_version)
        )
    `);
}

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

router.get('/release-notice', async (req, res) => {
    try {
        if (!req.user || !req.user.id) return res.status(401).json({ error: 'Não autenticado.' });
        await ensureTenantStructure();
        await ensureReleaseNoticeTable();

        const [userRows] = await pool.query(
            'SELECT id, tenant_id FROM usuarios WHERE id = ? LIMIT 1',
            [req.user.id]
        );
        if (!userRows.length) return res.status(401).json({ error: 'Não autenticado.' });

        const user = userRows[0];
        const [rows] = await pool.query(
            `SELECT id
             FROM usuario_release_notices
             WHERE tenant_id = ?
               AND usuario_id = ?
               AND release_version = ?
             LIMIT 1`,
            [user.tenant_id, user.id, CURRENT_RELEASE_NOTICE_VERSION]
        );

        return res.json({
            version: CURRENT_RELEASE_NOTICE_VERSION,
            show: !rows.length
        });
    } catch (err) {
        console.error('Erro ao consultar aviso de versão:', err);
        return res.status(500).json({ error: 'Erro ao consultar aviso de versão.' });
    }
});

router.post('/release-notice/ack', async (req, res) => {
    try {
        if (!req.user || !req.user.id) return res.status(401).json({ error: 'Não autenticado.' });
        await ensureTenantStructure();
        await ensureReleaseNoticeTable();

        const version = String((req.body && req.body.version) || CURRENT_RELEASE_NOTICE_VERSION).trim() || CURRENT_RELEASE_NOTICE_VERSION;
        const [userRows] = await pool.query(
            'SELECT id, tenant_id FROM usuarios WHERE id = ? LIMIT 1',
            [req.user.id]
        );
        if (!userRows.length) return res.status(401).json({ error: 'Não autenticado.' });

        const user = userRows[0];
        await pool.query(
            `INSERT INTO usuario_release_notices (tenant_id, usuario_id, release_version)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE acknowledged_at = acknowledged_at`,
            [user.tenant_id, user.id, version]
        );

        return res.json({ message: 'Aviso confirmado.' });
    } catch (err) {
        console.error('Erro ao confirmar aviso de versão:', err);
        return res.status(500).json({ error: 'Erro ao confirmar aviso de versão.' });
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
        if (!await verifyPassword(senha, user.senha)) return res.status(401).json({ error: 'Credenciais inválidas.' });
        if (!looksLikeBcryptHash(user.senha)) {
            const newHash = await hashPassword(senha);
            await pool.query('UPDATE usuarios SET senha = ? WHERE id = ? AND tenant_id = ?', [newHash, user.id, user.tenant_id]);
        }

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
