const express = require('express');
const path = require('path');
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
const PORT = Number(process.env.PORT || 3001);

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

app.use('/api/auth', authRoutes);
app.use('/api', activityLoggerMiddleware);
app.use('/api/module-users', moduleUsersRoutes);
app.use('/api/admin-users', adminUsersRoutes);
app.use('/api/logs', logsRoutes);

app.listen(PORT, () => {
    console.log(`SemearAdmin online em http://localhost:${PORT}`);
});
