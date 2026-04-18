const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'db_semearcatequese',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const corePool = mysql.createPool({
    host: process.env.CORE_DB_HOST || process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.CORE_DB_PORT || process.env.DB_PORT || 3306),
    user: process.env.CORE_DB_USER || process.env.DB_USER || 'root',
    password: process.env.CORE_DB_PASS || process.env.DB_PASSWORD || process.env.DB_PASS || '',
    database: process.env.CORE_DB_NAME || 'semear_core',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = { pool, corePool };
