const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: '127.0.0.1',
    user: 'infra',
    password: 'M4n3r@@G1nx',
    database: 'db_semeajovens'
});

const corePool = mysql.createPool({
    host: process.env.CORE_DB_HOST || process.env.DB_HOST || '127.0.0.1',
    user: process.env.CORE_DB_USER || process.env.DB_USER || 'infra',
    password: process.env.CORE_DB_PASS || process.env.DB_PASS || 'M4n3r@@G1nx',
    database: process.env.CORE_DB_NAME || 'semear_core'
});

async function registrarLog(usuario, acao, detalhes) {
    try {
        await pool.query('INSERT INTO logs (usuario, acao, detalhes) VALUES (?, ?, ?)', [usuario, acao, detalhes]);
    } catch (err) { console.error("Erro ao gravar log:", err); }
}

module.exports = { pool, corePool, registrarLog };
