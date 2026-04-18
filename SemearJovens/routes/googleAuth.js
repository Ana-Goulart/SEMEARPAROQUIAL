const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { pool } = require('../database');
const { setSessionCookie } = require('../lib/authSession');
const { ensureTenantStructure } = require('../lib/tenantSetup');

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
    return passport.authenticate('google', { scope: ['profile', 'email'], session: false })(req, res, next);
});

router.get('/google/callback', (req, res, next) => {
    if (!configureGoogleStrategy()) return res.redirect('/login?google=nao-configurado');
    return passport.authenticate('google', { failureRedirect: '/login?google=falha', session: false })(req, res, next);
}, async (req, res) => {
    try {
        await ensureTenantStructure();

        const profile = req.user || {};
        const googleId = String(profile.id || '').trim();
        const email = getPrimaryEmail(profile);
        const avatarUrl = getPrimaryPhoto(profile);

        if (!googleId || !email) return res.redirect('/login?google=email-invalido');

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

        if (!ativos.length) return res.redirect('/login?google=nao-autorizado');

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
        return res.redirect('/dashboard');
    } catch (err) {
        console.error('Erro no callback Google:', err);
        return res.redirect('/login?google=erro-servidor');
    }
});

module.exports = router;
