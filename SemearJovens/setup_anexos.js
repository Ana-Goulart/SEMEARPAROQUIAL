const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
    host: 'localhost',
    user: 'infra',
    password: 'anaclara14',
    database: 'db_semeajovens'
});

async function setup() {
    try {
        const connection = await pool.getConnection();
        console.log("Conectado ao banco de dados.");

        // Tabela de Pastas
        await connection.query(`
            CREATE TABLE IF NOT EXISTS pastas (
                id INT AUTO_INCREMENT PRIMARY KEY,
                nome VARCHAR(255) NOT NULL,
                parent_id INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (parent_id) REFERENCES pastas(id) ON DELETE CASCADE
            )
        `);
        console.log("Tabela 'pastas' verificada/criada.");

        // Tabela de Arquivos
        await connection.query(`
            CREATE TABLE IF NOT EXISTS arquivos (
                id INT AUTO_INCREMENT PRIMARY KEY,
                nome VARCHAR(255) NOT NULL,
                caminho VARCHAR(255) NOT NULL,
                mimetype VARCHAR(100),
                tamanho INT,
                pasta_id INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (pasta_id) REFERENCES pastas(id) ON DELETE CASCADE
            )
        `);
        console.log("Tabela 'arquivos' verificada/criada.");

        connection.release();
        process.exit(0);
    } catch (err) {
        console.error("Erro ao configurar banco:", err);
        process.exit(1);
    }
}

setup();
