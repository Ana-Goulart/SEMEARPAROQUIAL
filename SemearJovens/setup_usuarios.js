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

        // Tabela de Usuários
        await connection.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) NOT NULL UNIQUE,
                nome_completo VARCHAR(100) NOT NULL,
                senha VARCHAR(255) NOT NULL,
                data_entrada DATE,
                data_saida DATE,
                grupo ENUM('Tios', 'Jovens', 'Diretor Espiritual', 'Padre') NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log("Tabela 'usuarios' verificada/criada.");

        connection.release();
        process.exit(0);
    } catch (err) {
        console.error("Erro ao configurar banco:", err);
        process.exit(1);
    }
}

setup();
