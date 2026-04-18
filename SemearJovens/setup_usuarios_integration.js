const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
    host: 'localhost',
    user: 'infra',
    password: 'anaclara14',
    database: 'db_semeajovens'
});

async function migrate() {
    try {
        const connection = await pool.getConnection();
        console.log("Conectado ao banco de dados.");

        // 1. Adicionar coluna 'dirigente' na tabela 'jovens'
        try {
            await connection.query("ALTER TABLE jovens ADD COLUMN dirigente TINYINT(1) DEFAULT 0");
            console.log("Coluna 'dirigente' adicionada na tabela 'jovens'.");
        } catch (err) {
            if (err.code === 'ER_DUP_FIELDNAME') {
                console.log("Coluna 'dirigente' já existe em 'jovens'.");
            } else {
                throw err;
            }
        }

        // 2. Adicionar coluna 'jovem_id' na tabela 'usuarios' e chave estrangeira
        try {
            await connection.query("ALTER TABLE usuarios ADD COLUMN jovem_id INT NULL");
            await connection.query("ALTER TABLE usuarios ADD CONSTRAINT fk_usuario_jovem FOREIGN KEY (jovem_id) REFERENCES jovens(id) ON DELETE SET NULL");
            console.log("Coluna 'jovem_id' e FK adicionadas na tabela 'usuarios'.");
        } catch (err) {
            if (err.code === 'ER_DUP_FIELDNAME') {
                console.log("Coluna 'jovem_id' já existe em 'usuarios'.");
            } else {
                throw err;
            }
        }

        connection.release();
        process.exit(0);
    } catch (err) {
        console.error("Erro na migração:", err);
        process.exit(1);
    }
}

migrate();
