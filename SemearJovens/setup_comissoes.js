const { pool } = require('./database');

async function setupComissoes() {
    try {
        const connection = await pool.getConnection();
        console.log("Conectado ao banco de dados.");

        await connection.query(`
            CREATE TABLE IF NOT EXISTS jovens_comissoes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                jovem_id INT NOT NULL,
                tipo ENUM('MOITA_OUTRO', 'GARCOM_OUTRO', 'COORD_TERCO', 'COORD_MARKETING', 'COORD_EVENTOS', 'COORD_CIRCULO', 'COORD_MUSICA', 'DIRIGENTE') NOT NULL,
                
                -- Campos para Moita/Garçom em Outro EJC
                ejc_numero INT,
                paroquia VARCHAR(255),
                data_inicio DATE,
                data_fim DATE,
                funcao_garcom VARCHAR(50), -- 'Tio', 'Jovem', 'Coordenador'

                -- Campos para Coordenadores Internos
                semestre VARCHAR(20), -- '01/2025'
                circulo VARCHAR(50), -- Apenas para COORD_CIRCULO
                
                observacao TEXT,
                
                FOREIGN KEY (jovem_id) REFERENCES jovens(id) ON DELETE CASCADE
            )
        `);
        console.log("Tabela 'jovens_comissoes' criada/verificada.");

        connection.release();
        console.log("Setup de comissões concluído.");
        process.exit(0);
    } catch (err) {
        console.error("Erro no setup de comissões:", err);
        process.exit(1);
    }
}

setupComissoes();
