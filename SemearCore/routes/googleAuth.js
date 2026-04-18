const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { pool, corePool } = require('../database');
const { setSessionCookie } = require('../lib/authSession');

const router = express.Router();

let strategyConfigured = false;

function getPrimaryEmail(profile) {
    if (!profile || !Array.isArray(profile.emails)) return '';
    const first = profile.emails.find((item) => item && item.value);
    return String(first && first.value ? first.value : '').trim().toLowerCase();
}

function getPrimaryPhoto(profile) {
    if (!profile || !Array.isArray(profile.photos)) return null;
    const first = profile.photos.find((item) => item && item.value);
    return first && first.value ? String(first.value).trim() : null;
}

function getDefaultAfterLoginUrl() {
    return String(process.env.DEFAULT_AFTER_LOGIN_URL || 'https://ejc.semearparoquial.com.br:3003/dashboard').trim();
}

function resolveNextUrl(rawNext) {
    const fallback = getDefaultAfterLoginUrl();
    const value = String(rawNext || '').trim();
    if (!value) return fallback;
    if (!/^https?:\/\//i.test(value)) return fallback;
    return value;
}

function encodeState(next) {
    const value = String(next || '').trim();
    const sanitized = /^https?:\/\//i.test(value) ? value : '';
    return Buffer.from(JSON.stringify({ next: sanitized }), 'utf8').toString('base64url');
}

function decodeState(state) {
    try {
        if (!state) return '';
        const raw = Buffer.from(String(state), 'base64url').toString('utf8');
        const parsed = JSON.parse(raw);
        const candidate = String(parsed && parsed.next ? parsed.next : '').trim();
        if (!candidate) return '';
        return /^https?:\/\//i.test(candidate) ? candidate : '';
    } catch (_) {
        return '';
    }
}

function resolveAuthorizedNextUrl(rawNext, allowedBaseUrl) {
    const candidate = String(rawNext || '').trim();
    const allowed = String(allowedBaseUrl || '').trim();
    if (!candidate || !allowed) return '';

    try {
        const candidateUrl = new URL(candidate);
        const allowedUrl = new URL(allowed);

        // Aceita somente next para o mesmo host do sistema autorizado.
        if (candidateUrl.hostname.toLowerCase() !== allowedUrl.hostname.toLowerCase()) {
            return '';
        }

        return candidate;
    } catch (_) {
        return '';
    }
}

function buildSystemRedirectUrl(row) {
    const defaultUrl = getDefaultAfterLoginUrl();
    if (!row) return defaultUrl;
    const domain = String(row.domain || '').trim();
    if (!domain) return defaultUrl;
    const redirectProtocol = String(process.env.SYSTEM_REDIRECT_PROTOCOL || 'http').trim().toLowerCase() === 'https'
        ? 'https'
        : 'http';
    const withProtocol = /^https?:\/\//i.test(domain) ? domain : `${redirectProtocol}://${domain}`;
    return `${withProtocol.replace(/\/+$/, '')}/dashboard`;
}

async function resolveCoreGoogleAccess(googleId, email) {
    const [rows] = await corePool.query(
        `SELECT
            u.id AS user_id,
            u.legacy_source,
            u.legacy_user_id,
            u.google_sub,
            u.email,
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
           AND (u.google_sub = ? OR LOWER(u.email) = LOWER(?))`,
        [googleId, email]
    );

    if (!rows.length) return null;

    const preferred = rows.filter((row) => String(row.google_sub || '') === googleId);
    const candidates = preferred.length ? preferred : rows;

    const uniqueSystems = new Map();
    for (const row of candidates) {
        const key = `${row.system_id}:${String(row.domain || '').toLowerCase()}`;
        if (!uniqueSystems.has(key)) uniqueSystems.set(key, row);
    }

    const destinos = [...uniqueSystems.values()];
    if (!destinos.length) return null;
    if (destinos.length > 1) {
        return { multiSystem: true };
    }

    const selected = destinos[0];
    await corePool.query(
        `UPDATE users
         SET google_sub = COALESCE(google_sub, ?),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [googleId, selected.user_id]
    );

    let sessionUserId = Number(selected.user_id);
    const legacySource = String(selected.legacy_source || '').trim().toLowerCase();
    const legacyUserId = Number(selected.legacy_user_id || 0);
    const systemCode = String(selected.system_code || '').trim().toLowerCase();

    // Compatibilidade com o EJC (db_semeajovens.usuarios.id).
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

function configureGoogleStrategy() {
    if (strategyConfigured) return true;

    const clientID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
    const callbackURL = String(process.env.GOOGLE_CALLBACK_URL || '').trim();

    if (!clientID || !clientSecret || !callbackURL) {
        console.error('Google OAuth não configurado: faltam GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_CALLBACK_URL.');
        return false;
    }

    passport.use(new GoogleStrategy(
        { clientID, clientSecret, callbackURL },
        async (_accessToken, _refreshToken, profile, done) => {
            try {
                return done(null, profile);
            } catch (err) {
                return done(err);
            }
        }
    ));

    strategyConfigured = true;
    return true;
}

router.use(passport.initialize());

router.get('/google', (req, res, next) => {
    if (!configureGoogleStrategy()) return res.redirect('/login?google=nao-configurado');
    const state = encodeState(req.query.next);
    return passport.authenticate('google', { scope: ['profile', 'email'], session: false, state })(req, res, next);
});

router.get('/google/callback', (req, res, next) => {
    if (!configureGoogleStrategy()) return res.redirect('/login?google=nao-configurado');
    return passport.authenticate('google', { failureRedirect: '/login?google=falha', session: false })(req, res, next);
}, async (req, res) => {
    const nextUrl = decodeState(req.query.state);
    try {
        const profile = req.user || {};
        const googleId = String(profile.id || '').trim();
        const email = getPrimaryEmail(profile);
        const avatarUrl = getPrimaryPhoto(profile);

        if (!googleId || !email) return res.redirect('/login?google=email-invalido');

        // Novo fluxo (semear_core): usuário + acessos por sistema/domínio
        try {
            const coreResult = await resolveCoreGoogleAccess(googleId, email);
            if (coreResult && coreResult.multiSystem) {
                return res.redirect('/login?google=multi-sistema');
            }
            if (coreResult && coreResult.userId) {
                setSessionCookie(res, coreResult.sessionUserId || coreResult.userId);
                const safeNext = resolveAuthorizedNextUrl(nextUrl, coreResult.redirectTo);
                return res.redirect(safeNext || coreResult.redirectTo || resolveNextUrl(''));
            }
        } catch (coreErr) {
            console.error('Falha no fluxo semear_core, aplicando fallback legado:', coreErr);
        }

        // Fallback legado: usuários do db_semeajovens
        const [rows] = await pool.query(
            `SELECT u.id, u.username, u.google_id, u.tenant_id, t.ativo
             FROM usuarios u
             LEFT JOIN tenants_ejc t ON t.id = u.tenant_id
             WHERE u.google_id = ? OR LOWER(u.username) = LOWER(?)`,
            [googleId, email]
        );

        const ativos = (rows || []).filter((row) => {
            if (!row.tenant_id) return true;
            return Number(row.ativo) === 1;
        });

        if (!ativos.length) return res.redirect('/login?google=nao-cadastrado');

        const preferGoogleId = ativos.filter((row) => String(row.google_id || '') === googleId);
        const candidatos = preferGoogleId.length ? preferGoogleId : ativos;

        if (candidatos.length > 1) {
            return res.redirect('/login?google=multi-tenant');
        }

        const user = candidatos[0];
        await pool.query(
            `UPDATE usuarios
             SET google_id = COALESCE(google_id, ?),
                 avatar_url = COALESCE(?, avatar_url)
             WHERE id = ?`,
            [googleId, avatarUrl, user.id]
        );

        setSessionCookie(res, user.id);
        const fallbackRedirect = resolveNextUrl('');
        const safeNext = resolveAuthorizedNextUrl(nextUrl, fallbackRedirect);
        return res.redirect(safeNext || fallbackRedirect);
    } catch (err) {
        console.error('Erro no callback Google:', err);
        return res.redirect('/login?google=erro-servidor');
    }
});

module.exports = router;
