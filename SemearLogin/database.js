const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'infra',
    password: process.env.DB_PASS || process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'db_semeajovens',
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
    queueLimit: 0
});

const corePool = mysql.createPool({
    host: process.env.CORE_DB_HOST || process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.CORE_DB_PORT || process.env.DB_PORT || 3306),
    user: process.env.CORE_DB_USER || process.env.DB_USER || 'infra',
    password: process.env.CORE_DB_PASS || process.env.DB_PASS || process.env.DB_PASSWORD || '',
    database: process.env.CORE_DB_NAME || 'semear_core',
    waitForConnections: true,
    connectionLimit: Number(process.env.CORE_DB_POOL_SIZE || process.env.DB_POOL_SIZE || 10),
    queueLimit: 0
});

module.exports = { pool, corePool };
