const { pool } = require('./database');

async function setupVotacao() {
    try {
        const connection = await pool.getConnection();
        console.log("Conectado ao banco de dados.");

        // DROPS para garantir schema limpo (dev mode)
        // Cuidado em produção, mas aqui estamos refatorando
        await connection.query('DROP TABLE IF EXISTS votos');
        await connection.query('DROP TABLE IF EXISTS votacao_candidatos');
        await connection.query('DROP TABLE IF EXISTS votacoes');
        await connection.query('DROP TABLE IF EXISTS votacoes_pastas');

        console.log("Tabelas antigas removidas.");

        // 1. Tabela de Pastas
        await connection.query(`
            CREATE TABLE IF NOT EXISTS votacoes_pastas (
                id INT AUTO_INCREMENT PRIMARY KEY,
                nome VARCHAR(255) NOT NULL,
                data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log("Tabela 'votacoes_pastas' criada.");

        // 2. Tabela de Votações (Sessões)
        await connection.query(`
            CREATE TABLE IF NOT EXISTS votacoes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                pasta_id INT,
                titulo VARCHAR(255) NOT NULL,
                data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP,
                ativa BOOLEAN DEFAULT TRUE,
                FOREIGN KEY (pasta_id) REFERENCES votacoes_pastas(id) ON DELETE CASCADE
            )
        `);
        console.log("Tabela 'votacoes' criada.");

        // 3. Tabela de Candidatos da Votação (Colunas da Matriz)
        await connection.query(`
            CREATE TABLE IF NOT EXISTS votacao_candidatos (
                votacao_id INT NOT NULL,
                candidato_id INT NOT NULL,
                PRIMARY KEY (votacao_id, candidato_id),
                FOREIGN KEY (votacao_id) REFERENCES votacoes(id) ON DELETE CASCADE,
                FOREIGN KEY (candidato_id) REFERENCES jovens(id) ON DELETE CASCADE
            )
        `);
        console.log("Tabela 'votacao_candidatos' criada.");

        // 4. Tabela de Votos (Células da Matriz)
        // Agora sem restrição unique de pontos, pois pode repetir nota
        await connection.query(`
            CREATE TABLE IF NOT EXISTS votos (
                id INT AUTO_INCREMENT PRIMARY KEY,
                votacao_id INT NOT NULL,
                eleitor_id INT NOT NULL, -- Quem votou (Usuário do sistema / Linha da matriz)
                candidato_id INT NOT NULL, -- Quem recebeu o voto (Coluna da matriz)
                pontos INT NOT NULL,
                data_voto DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (votacao_id) REFERENCES votacoes(id) ON DELETE CASCADE,
                FOREIGN KEY (eleitor_id) REFERENCES usuarios(id) ON DELETE CASCADE,
                FOREIGN KEY (candidato_id) REFERENCES jovens(id) ON DELETE CASCADE,
                UNIQUE KEY unique_voto_celula (votacao_id, eleitor_id, candidato_id)
            )
        `);
        console.log("Tabela 'votos' criada.");

        connection.release();
        console.log("Setup de votação (Refatorado) concluído.");
        process.exit(0);
    } catch (err) {
        console.error("Erro no setup de votação:", err);
        process.exit(1);
    }
}

setupVotacao();
