const express = require('express');
const helmet = require('helmet');
const path = require('path');
const rateLimit = require('express-rate-limit');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const { attachUserFromSession } = require('./lib/authSession');
const rotasAuth = require('./routes/auth');

const app = express();
const PORT = Number(process.env.PORT || 3004);
const GLOBAL_RATE_LIMIT_WINDOW_MS = Number(process.env.GLOBAL_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const GLOBAL_RATE_LIMIT_MAX = Number(process.env.GLOBAL_RATE_LIMIT_MAX || 300);

app.set('trust proxy', 1);

const globalLimiter = rateLimit({
    windowMs: GLOBAL_RATE_LIMIT_WINDOW_MS,
    limit: GLOBAL_RATE_LIMIT_MAX,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: (req) => req.path === '/health',
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
app.get('/favicon.ico', (_req, res) => res.status(204).end());
app.use(globalLimiter);
app.use(express.json());
app.use(attachUserFromSession);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.get('/', (_req, res) => res.redirect('/login'));

app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', rotasAuth);

app.listen(PORT, () => {
    console.log(`SemearLogin rodando na porta ${PORT}`);
});
