-- ===== TABELA EJC =====
-- Armazena as edições do EJC com número e paróquia
CREATE TABLE IF NOT EXISTS ejc (
    id INT AUTO_INCREMENT PRIMARY KEY,
    numero INT NOT NULL UNIQUE,
    paroquia VARCHAR(100) NOT NULL,
    ano INT,
    descricao TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ===== TABELA EQUIPES =====
-- Lista de todas as possíveis equipes (global, reutilizável em todos os EJCs)
CREATE TABLE IF NOT EXISTS equipes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(100) NOT NULL UNIQUE,
    descricao TEXT,
    icone_classe VARCHAR(120) NULL,
    cor_icone VARCHAR(20) DEFAULT '#2563eb',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE equipes
ADD COLUMN IF NOT EXISTS icone_classe VARCHAR(120) NULL;

ALTER TABLE equipes
ADD COLUMN IF NOT EXISTS cor_icone VARCHAR(20) DEFAULT '#2563eb';

ALTER TABLE montagens
ADD COLUMN IF NOT EXISTS data_inicio DATE NULL;

ALTER TABLE montagens
ADD COLUMN IF NOT EXISTS data_fim DATE NULL;

-- ===== TABELAS MONTAGEM (REUNIÕES E PRESENÇAS) =====
CREATE TABLE IF NOT EXISTS montagem_reunioes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    montagem_id INT NOT NULL,
    data_reuniao DATE NOT NULL,
    periodo VARCHAR(120) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_montagem_reuniao (montagem_id, data_reuniao)
);

CREATE TABLE IF NOT EXISTS montagem_reunioes_presencas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    montagem_id INT NOT NULL,
    reuniao_id INT NOT NULL,
    jovem_id INT NOT NULL,
    presente TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_reuniao_jovem (reuniao_id, jovem_id),
    KEY idx_montagem_jovem (montagem_id, jovem_id)
);

-- ===== ATUALIZAÇÃO CADASTRAL (FORMULÁRIO PÚBLICO) =====
CREATE TABLE IF NOT EXISTS jovens_atualizacao_comentarios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NULL,
    jovem_id INT NULL,
    nome_completo VARCHAR(180) NULL,
    telefone VARCHAR(30) NULL,
    comentario TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jovens_atualizacao_nao_encontrado (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NULL,
    nome_completo VARCHAR(180) NOT NULL,
    telefone VARCHAR(30) NOT NULL,
    ejc_que_fez VARCHAR(180) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ===== TABELA FINANCEIRO =====
CREATE TABLE IF NOT EXISTS financeiro_movimentacoes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tipo ENUM('ENTRADA', 'SAIDA') NOT NULL,
    valor DECIMAL(12,2) NOT NULL,
    descricao VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ===== TABELA EQUIPES_EJC =====
-- Relaciona quais equipes fazem parte de cada EJC (N:N)
-- Possibilita que diferentes EJCs tenham diferentes equipes
CREATE TABLE IF NOT EXISTS equipes_ejc (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ejc_id INT NOT NULL,
    equipe_id INT NOT NULL,
    FOREIGN KEY (ejc_id) REFERENCES ejc(id) ON DELETE CASCADE,
    FOREIGN KEY (equipe_id) REFERENCES equipes(id) ON DELETE CASCADE,
    UNIQUE KEY unique_ejc_equipe (ejc_id, equipe_id)
);

-- ===== TABELA JOVENS (MODIFICADA) =====
-- Nota: numero_ejc_fez já pode existir, não será adicionada novamente

-- ===== TABELA HISTORICO_EQUIPES (MODIFICADA) =====
-- Adicionar ejc_id se não existir (para referenciar qual EJC o jovem serviu)
ALTER TABLE historico_equipes
ADD COLUMN ejc_id INT,
ADD FOREIGN KEY (ejc_id) REFERENCES ejc(id) ON DELETE CASCADE;

-- Adicionar subfunção específica dentro da equipe (ex: Animador, Intercessor)
ALTER TABLE historico_equipes
ADD COLUMN IF NOT EXISTS subfuncao VARCHAR(120) NULL;

-- Funções de equipe agora podem indicar o papel base para refletir na montagem
ALTER TABLE equipes_funcoes
ADD COLUMN IF NOT EXISTS papel_base VARCHAR(50) DEFAULT 'Membro';

ALTER TABLE equipes_funcoes
MODIFY COLUMN papel_base VARCHAR(50) DEFAULT 'Membro';

-- ===== TABELAS PASTORAIS =====
CREATE TABLE IF NOT EXISTS pastorais (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    nome VARCHAR(180) NOT NULL,
    descricao VARCHAR(255) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pastorais_jovens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    pastoral_id INT NOT NULL,
    jovem_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_pastoral_jovem (tenant_id, pastoral_id, jovem_id)
);

ALTER TABLE contatos_telefonicos
ADD COLUMN IF NOT EXISTS pastoral_id INT NULL;

-- Papéis configuráveis (base para funções: ex. Membro, Tio, Coordenador e outros)
CREATE TABLE IF NOT EXISTS equipes_papeis (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(50) NOT NULL UNIQUE,
    ordem INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT IGNORE INTO equipes_papeis (nome, ordem) VALUES
('Membro', 1),
('Tio', 2),
('Coordenador', 3);

-- Tabela de funções padrão globais (aplicadas em todas as equipes)
CREATE TABLE IF NOT EXISTS equipes_funcoes_padrao (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(120) NOT NULL,
    papel_base VARCHAR(50) DEFAULT 'Membro',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_funcao_padrao (nome, papel_base)
);

ALTER TABLE equipes_funcoes_padrao
MODIFY COLUMN papel_base VARCHAR(50) DEFAULT 'Membro';

-- Vincula funções da equipe que vieram de uma função padrão global
ALTER TABLE equipes_funcoes
ADD COLUMN IF NOT EXISTS origem_padrao_id INT NULL;

-- Opção B: Se quer referencia total (mais normalizado)
-- ALTER TABLE historico_equipes
-- ADD COLUMN equipe_id INT,
-- ADD FOREIGN KEY (equipe_id) REFERENCES equipes(id) ON DELETE CASCADE;

-- ===== INSERÇÕES DE EXEMPLO =====
-- EJCs



-- Equipes (fixas, globais)
INSERT INTO equipes (nome, descricao) VALUES 
('Cozinha', 'Responsável pelas refeições'),
('Ordem', 'Mantém a disciplina e organização'),
('Comunicação', 'Gerencia comunicação e mídias'),
('Saúde', 'Cuida da saúde dos participantes'),
('Logística', 'Transporte e logística geral'),
('Espiritualidade', 'Momentos religiosos e reflexivos');

-- Equipes por EJC (exemplo: todos têm as mesmas, mas poderia variar)
INSERT INTO equipes_ejc (ejc_id, equipe_id) 
SELECT ejc.id, equipes.id FROM ejc CROSS JOIN equipes;

-- ===== ALTERAÇÃO: campo para armazenar paróquia informada do cônjuge quando não há EJC vinculado =====
ALTER TABLE jovens
ADD COLUMN IF NOT EXISTS conjuge_paroquia VARCHAR(255) DEFAULT NULL;

-- ===== ALTERAÇÃO: campo para armazenar a foto do jovem =====
ALTER TABLE jovens
ADD COLUMN IF NOT EXISTS foto_url VARCHAR(255) DEFAULT NULL;

ALTER TABLE jovens
ADD COLUMN IF NOT EXISTS eh_musico TINYINT(1) DEFAULT 0;

ALTER TABLE jovens
ADD COLUMN IF NOT EXISTS instrumentos_musicais TEXT NULL;

ALTER TABLE jovens_comissoes
MODIFY COLUMN tipo VARCHAR(120) NOT NULL;

ALTER TABLE jovens_comissoes
ADD COLUMN IF NOT EXISTS coordenacao_nome VARCHAR(120) NULL;

CREATE TABLE IF NOT EXISTS coordenacoes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(120) NOT NULL,
    pasta_id INT NULL,
    periodo VARCHAR(50) NULL,
    descricao TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE coordenacoes
ADD COLUMN IF NOT EXISTS pasta_id INT NULL;

CREATE TABLE IF NOT EXISTS coordenacoes_pastas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(120) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS coordenacoes_membros (
    id INT AUTO_INCREMENT PRIMARY KEY,
    coordenacao_id INT NOT NULL,
    jovem_id INT NOT NULL,
    comissao_id INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_coord_jovem (coordenacao_id, jovem_id),
    CONSTRAINT fk_coord_membro_coord FOREIGN KEY (coordenacao_id) REFERENCES coordenacoes(id) ON DELETE CASCADE,
    CONSTRAINT fk_coord_membro_jovem FOREIGN KEY (jovem_id) REFERENCES jovens(id) ON DELETE CASCADE
);
