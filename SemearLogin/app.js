const express = require('express');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const { attachUserFromSession } = require('./lib/authSession');
const rotasAuth = require('./routes/auth');

const app = express();
const PORT = Number(process.env.PORT || 3002);

app.use(express.json());
app.use(attachUserFromSession);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.get('/', (_req, res) => res.redirect('/login'));

app.use('/api/auth', rotasAuth);

app.listen(PORT, () => {
    console.log(`SemearLogin rodando na porta ${PORT}`);
});
