const express = require('express');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const rotasUsuarios = require('./routes/usuarios');

const app = express();
const PORT = Number(process.env.PORT || 3004);

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
