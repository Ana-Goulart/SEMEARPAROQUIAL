const express = require('express');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const { attachUserFromSession } = require('./lib/authSession');
const { attachAdminFromSession, clearAdminSessionCookie } = require('./lib/adminSession');
const rotasAuth = require('./routes/auth');
const rotasAdminSistema = require('./routes/adminSistema');
const rotasLogs = require('./routes/logs');
const { pool } = require('./database');
const { ensureTenantStructure } = require('./lib/tenantSetup');
const { activityLoggerMiddleware } = require('./lib/activityLogs');

const app = express();
const SUPERADMIN_HOSTNAME = String(process.env.SUPERADMIN_HOSTNAME || 'ana.semearparoquial.com.br').trim().toLowerCase();
const LOGIN_APP_URL = String(process.env.LOGIN_APP_URL || 'http://login.semearparoquial.com.br/login').trim();

app.use(express.json());
app.use(attachUserFromSession);
app.use(attachAdminFromSession);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ ok: true }));

function getRequestHostname(req) {
    return String(req.hostname || '').trim().toLowerCase();
}

function isSuperAdminHost(req) {
    const host = getRequestHostname(req);
    return !!(host && host === SUPERADMIN_HOSTNAME);
}

app.use((req, res, next) => {
    if (!isSuperAdminHost(req)) return next();

    if (req.path === '/') return res.redirect('/admin/login');

    const isAllowedPath = req.path.startsWith('/admin')
        || req.path.startsWith('/api/admin')
        || req.path.startsWith('/assets/')
        || req.path.startsWith('/css/')
        || req.path.startsWith('/js/')
        || req.path === '/favicon.ico'
        || req.path === '/health';

    if (!isAllowedPath) {
        if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Endpoint indisponível no domínio ana.' });
        return res.redirect('/admin/login');
    }
    next();
});

async function requireAdminView(req, res, next) {
    if (!req.admin || !req.admin.id) return res.redirect('/admin/login');
    try {
        await ensureTenantStructure();
        const [rows] = await pool.query('SELECT id, ativo FROM admin_usuarios WHERE id = ? LIMIT 1', [req.admin.id]);
        if (!rows.length || !rows[0].ativo) {
            clearAdminSessionCookie(res);
            return res.redirect('/admin/login');
        }
        next();
    } catch (err) {
        console.error('Erro ao validar sessão admin view:', err);
        clearAdminSessionCookie(res);
        return res.redirect('/admin/login');
    }
}

app.get('/login', (_req, res) => res.redirect(LOGIN_APP_URL));
app.get('/', (_req, res) => res.redirect('/login'));
app.get('/admin/login', (_req, res) => res.sendFile(path.join(__dirname, 'views', 'admin-login.html')));
app.get('/admin', requireAdminView, (_req, res) => res.sendFile(path.join(__dirname, 'views', 'admin.html')));

app.use('/api/auth', rotasAuth);
app.use('/api/admin', activityLoggerMiddleware);
app.use('/api/admin/logs', rotasLogs);
app.use('/api/admin', rotasAdminSistema);

app.listen(Number(process.env.PORT || 3000), () => {
    console.log(`🚀 SemearCore rodando na porta ${Number(process.env.PORT || 3000)}`);
});
