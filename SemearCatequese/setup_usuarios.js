const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { pool } = require('./database');

async function setup() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS usuarios (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nome_completo VARCHAR(160) NOT NULL,
            username VARCHAR(120) NOT NULL UNIQUE,
            senha VARCHAR(255) NOT NULL,
            grupo VARCHAR(80) NOT NULL,
            ativo TINYINT(1) NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);

    console.log('Tabela usuarios pronta.');
}

setup()
    .catch((err) => {
        console.error('Erro no setup:', err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
