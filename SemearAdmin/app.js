const express = require('express');
const helmet = require('helmet');
const path = require('path');
const rateLimit = require('express-rate-limit');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const { attachAdminFromSession, clearAdminSessionCookie } = require('./lib/authSession');
const { pool } = require('./database');
const { ensureStructure } = require('./lib/setup');
const authRoutes = require('./routes/auth');
const moduleUsersRoutes = require('./routes/moduleUsers');
const adminUsersRoutes = require('./routes/adminUsers');
const logsRoutes = require('./routes/logs');
const { activityLoggerMiddleware } = require('./lib/activityLogs');

const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 3001);
const GLOBAL_RATE_LIMIT_WINDOW_MS = Number(process.env.GLOBAL_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const GLOBAL_RATE_LIMIT_MAX = Number(process.env.GLOBAL_RATE_LIMIT_MAX || 3000);

app.set('trust proxy', 1);

const globalLimiter = rateLimit({
    windowMs: GLOBAL_RATE_LIMIT_WINDOW_MS,
    limit: GLOBAL_RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    validate: false,
    skip: (req) => req.method === 'OPTIONS' || req.path === '/health',
    handler: (_req, res) => res.status(429).json({ error: 'Muitas requisições. Tente novamente em alguns minutos.' })
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' })
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(globalLimiter);
app.use(express.json());
app.use(attachAdminFromSession);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ ok: true }));

async function requireAdminView(req, res, next) {
    if (!req.admin || !req.admin.id || !req.admin.tenant_id) return res.redirect('/login');
    try {
        await ensureStructure();
        const [rows] = await pool.query(
            `SELECT ta.id
             FROM tenant_admin_users ta
             JOIN tenants_ejc t ON t.id = ta.tenant_id
             WHERE ta.id = ? AND ta.tenant_id = ? AND ta.ativo = 1 AND t.ativo = 1
             LIMIT 1`,
            [req.admin.id, req.admin.tenant_id]
        );
        if (!rows.length) {
            clearAdminSessionCookie(res);
            return res.redirect('/login');
        }
        return next();
    } catch (err) {
        console.error('Erro ao validar sessão do admin da paróquia:', err);
        clearAdminSessionCookie(res);
        return res.redirect('/login');
    }
}

app.get('/', (_req, res) => res.redirect('/login'));
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.get('/painel', requireAdminView, (_req, res) => res.sendFile(path.join(__dirname, 'views', 'admin.html')));

app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', authRoutes);
app.use('/api', activityLoggerMiddleware);
app.use('/api/module-users', moduleUsersRoutes);
app.use('/api/admin-users', adminUsersRoutes);
app.use('/api/logs', logsRoutes);

app.listen(PORT, () => {
    console.log(`SemearAdmin online em http://localhost:${PORT}`);
});
