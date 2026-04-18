const { pool } = require('./database');

async function columnExists(connection, table, column) {
    const [rows] = await connection.query(
        `SELECT COUNT(*) AS cnt
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND COLUMN_NAME = ?`,
        [table, column]
    );
    return !!(rows && rows[0] && rows[0].cnt > 0);
}

async function setupSubfuncoesEquipes() {
    const connection = await pool.getConnection();
    try {
        console.log('Iniciando migração de subfunções...');

        const hasSubfuncao = await columnExists(connection, 'historico_equipes', 'subfuncao');
        if (!hasSubfuncao) {
            await connection.query('ALTER TABLE historico_equipes ADD COLUMN subfuncao VARCHAR(120) NULL');
            console.log("Coluna 'historico_equipes.subfuncao' criada.");
        } else {
            console.log("Coluna 'historico_equipes.subfuncao' já existe.");
        }

        const hasPapelBase = await columnExists(connection, 'equipes_funcoes', 'papel_base');
        if (!hasPapelBase) {
            await connection.query(
                "ALTER TABLE equipes_funcoes ADD COLUMN papel_base VARCHAR(50) DEFAULT 'Membro'"
            );
            console.log("Coluna 'equipes_funcoes.papel_base' criada.");
        } else {
            console.log("Coluna 'equipes_funcoes.papel_base' já existe.");
        }

        await connection.query("ALTER TABLE equipes_funcoes MODIFY COLUMN papel_base VARCHAR(50) DEFAULT 'Membro'");
        console.log("Coluna 'equipes_funcoes.papel_base' convertida para VARCHAR(50).");

        await connection.query(`
            CREATE TABLE IF NOT EXISTS equipes_papeis (
                id INT AUTO_INCREMENT PRIMARY KEY,
                nome VARCHAR(50) NOT NULL UNIQUE,
                ordem INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log("Tabela 'equipes_papeis' verificada.");

        await connection.query(`
            INSERT IGNORE INTO equipes_papeis (nome, ordem) VALUES
            ('Membro', 1),
            ('Tio', 2),
            ('Coordenador', 3)
        `);
        console.log("Papéis padrão garantidos em 'equipes_papeis'.");

        await connection.query(`
            CREATE TABLE IF NOT EXISTS equipes_funcoes_padrao (
                id INT AUTO_INCREMENT PRIMARY KEY,
                nome VARCHAR(120) NOT NULL,
                papel_base VARCHAR(50) DEFAULT 'Membro',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY unique_funcao_padrao (nome, papel_base)
            )
        `);
        console.log("Tabela 'equipes_funcoes_padrao' verificada.");

        await connection.query("ALTER TABLE equipes_funcoes_padrao MODIFY COLUMN papel_base VARCHAR(50) DEFAULT 'Membro'");
        console.log("Coluna 'equipes_funcoes_padrao.papel_base' convertida para VARCHAR(50).");

        const hasOrigemPadrao = await columnExists(connection, 'equipes_funcoes', 'origem_padrao_id');
        if (!hasOrigemPadrao) {
            await connection.query('ALTER TABLE equipes_funcoes ADD COLUMN origem_padrao_id INT NULL');
            console.log("Coluna 'equipes_funcoes.origem_padrao_id' criada.");
        } else {
            console.log("Coluna 'equipes_funcoes.origem_padrao_id' já existe.");
        }

        const hasIconeClasse = await columnExists(connection, 'equipes', 'icone_classe');
        if (!hasIconeClasse) {
            await connection.query("ALTER TABLE equipes ADD COLUMN icone_classe VARCHAR(120) NULL");
            console.log("Coluna 'equipes.icone_classe' criada.");
        } else {
            console.log("Coluna 'equipes.icone_classe' já existe.");
        }

        const hasCorIcone = await columnExists(connection, 'equipes', 'cor_icone');
        if (!hasCorIcone) {
            await connection.query("ALTER TABLE equipes ADD COLUMN cor_icone VARCHAR(20) DEFAULT '#2563eb'");
            console.log("Coluna 'equipes.cor_icone' criada.");
        } else {
            console.log("Coluna 'equipes.cor_icone' já existe.");
        }

        const hasMontagemDataInicio = await columnExists(connection, 'montagens', 'data_inicio');
        if (!hasMontagemDataInicio) {
            await connection.query("ALTER TABLE montagens ADD COLUMN data_inicio DATE NULL");
            await connection.query("UPDATE montagens SET data_inicio = COALESCE(data_inicio, data_encontro)");
            console.log("Coluna 'montagens.data_inicio' criada e preenchida com data_encontro.");
        } else {
            console.log("Coluna 'montagens.data_inicio' já existe.");
        }

        const hasMontagemDataFim = await columnExists(connection, 'montagens', 'data_fim');
        if (!hasMontagemDataFim) {
            await connection.query("ALTER TABLE montagens ADD COLUMN data_fim DATE NULL");
            await connection.query("UPDATE montagens SET data_fim = COALESCE(data_fim, data_encontro)");
            console.log("Coluna 'montagens.data_fim' criada e preenchida com data_encontro.");
        } else {
            console.log("Coluna 'montagens.data_fim' já existe.");
        }

        const hasEhMusico = await columnExists(connection, 'jovens', 'eh_musico');
        if (!hasEhMusico) {
            await connection.query("ALTER TABLE jovens ADD COLUMN eh_musico TINYINT(1) DEFAULT 0");
            console.log("Coluna 'jovens.eh_musico' criada.");
        } else {
            console.log("Coluna 'jovens.eh_musico' já existe.");
        }

        const hasInstrumentosMusicais = await columnExists(connection, 'jovens', 'instrumentos_musicais');
        if (!hasInstrumentosMusicais) {
            await connection.query("ALTER TABLE jovens ADD COLUMN instrumentos_musicais TEXT NULL");
            console.log("Coluna 'jovens.instrumentos_musicais' criada.");
        } else {
            console.log("Coluna 'jovens.instrumentos_musicais' já existe.");
        }

        const [hasTabelaComissoesRows] = await connection.query(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'jovens_comissoes'
        `);
        if (hasTabelaComissoesRows && hasTabelaComissoesRows[0] && hasTabelaComissoesRows[0].cnt > 0) {
            await connection.query("ALTER TABLE jovens_comissoes MODIFY COLUMN tipo VARCHAR(120) NOT NULL");
            console.log("Coluna 'jovens_comissoes.tipo' convertida para VARCHAR(120).");
            const hasCoordNome = await columnExists(connection, 'jovens_comissoes', 'coordenacao_nome');
            if (!hasCoordNome) {
                await connection.query("ALTER TABLE jovens_comissoes ADD COLUMN coordenacao_nome VARCHAR(120) NULL");
                console.log("Coluna 'jovens_comissoes.coordenacao_nome' criada.");
            } else {
                console.log("Coluna 'jovens_comissoes.coordenacao_nome' já existe.");
            }
        }

        await connection.query(`
            CREATE TABLE IF NOT EXISTS coordenacoes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                nome VARCHAR(120) NOT NULL,
                pasta_id INT NULL,
                periodo VARCHAR(50) NULL,
                descricao TEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log("Tabela 'coordenacoes' verificada.");

        try {
            const [idxRows] = await connection.query(`
                SELECT INDEX_NAME
                FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = 'coordenacoes'
                  AND COLUMN_NAME = 'nome'
                  AND NON_UNIQUE = 0
                  AND INDEX_NAME <> 'PRIMARY'
            `);
            for (const idx of idxRows || []) {
                await connection.query(`ALTER TABLE coordenacoes DROP INDEX \`${idx.INDEX_NAME}\``);
            }
            console.log("Índices únicos antigos de 'coordenacoes.nome' removidos (se existiam).");
        } catch (e) { }

        const hasCoordenacaoPastaId = await columnExists(connection, 'coordenacoes', 'pasta_id');
        if (!hasCoordenacaoPastaId) {
            await connection.query("ALTER TABLE coordenacoes ADD COLUMN pasta_id INT NULL");
            console.log("Coluna 'coordenacoes.pasta_id' criada.");
        } else {
            console.log("Coluna 'coordenacoes.pasta_id' já existe.");
        }

        await connection.query(`
            CREATE TABLE IF NOT EXISTS coordenacoes_pastas (
                id INT AUTO_INCREMENT PRIMARY KEY,
                nome VARCHAR(120) NOT NULL UNIQUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log("Tabela 'coordenacoes_pastas' verificada.");

        await connection.query(`
            CREATE TABLE IF NOT EXISTS coordenacoes_membros (
                id INT AUTO_INCREMENT PRIMARY KEY,
                coordenacao_id INT NOT NULL,
                jovem_id INT NOT NULL,
                comissao_id INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_coord_jovem (coordenacao_id, jovem_id),
                CONSTRAINT fk_coord_membro_coord FOREIGN KEY (coordenacao_id) REFERENCES coordenacoes(id) ON DELETE CASCADE,
                CONSTRAINT fk_coord_membro_jovem FOREIGN KEY (jovem_id) REFERENCES jovens(id) ON DELETE CASCADE
            )
        `);
        console.log("Tabela 'coordenacoes_membros' verificada.");

        console.log('Migração concluída.');
    } catch (err) {
        console.error('Erro na migração de subfunções:', err);
        process.exitCode = 1;
    } finally {
        connection.release();
        process.exit();
    }
}

setupSubfuncoesEquipes();
