const express = require('express');
const helmet = require('helmet');
const path = require('path');
const rateLimit = require('express-rate-limit');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const rotasUsuarios = require('./routes/usuarios');

const app = express();
const PORT = Number(process.env.PORT || 3004);
const GLOBAL_RATE_LIMIT_WINDOW_MS = Number(process.env.GLOBAL_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const GLOBAL_RATE_LIMIT_MAX = Number(process.env.GLOBAL_RATE_LIMIT_MAX || 300);

const globalLimiter = rateLimit({
    windowMs: GLOBAL_RATE_LIMIT_WINDOW_MS,
    limit: GLOBAL_RATE_LIMIT_MAX,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: (req) => req.path === '/api/ping',
    handler: (_req, res) => res.status(429).json({ error: 'Muitas requisições. Tente novamente em alguns minutos.' })
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(globalLimiter);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/favicon.ico', (_req, res) => res.redirect('/assets/logo-oficial.png'));

app.get('/', (_req, res) => res.redirect('/dashboard'));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));
app.get('/usuarios', (_req, res) => res.sendFile(path.join(__dirname, 'views', 'usuarios.html')));

app.get('/api/ping', (_req, res) => {
    res.json({
        ok: true,
        system: process.env.SYSTEM_NAME || 'Semear Catequese Infantil',
        domain: process.env.SYSTEM_DOMAIN || 'catequese-infantil.semearparoquial.com.br:3004',
        ts: new Date().toISOString()
    });
});

app.use('/api/usuarios', rotasUsuarios);

app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Erro interno no servidor.' });
});

app.listen(PORT, () => {
    console.log(`Semear Catequese online em http://localhost:${PORT}`);
});
