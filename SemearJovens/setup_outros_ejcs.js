const db = require('./database');

async function setup() {
    try {
        console.log("Iniciando setup da tabela outros_ejcs...");

        await db.pool.query(`
            CREATE TABLE IF NOT EXISTS outros_ejcs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                nome VARCHAR(150) NOT NULL,
                paroquia VARCHAR(150),
                bairro VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        console.log("✅ Tabela 'outros_ejcs' criada ou já existente!");
        process.exit(0);
    } catch (error) {
        console.error("❌ Erro ao configurar banco:", error);
        process.exit(1);
    }
}

setup();
