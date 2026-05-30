SET @has_equipe_saude_tipo := (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'jovens'
      AND COLUMN_NAME = 'equipe_saude_tipo'
);
SET @sql_equipe_saude_tipo := IF(
    @has_equipe_saude_tipo = 0,
    'ALTER TABLE jovens ADD COLUMN equipe_saude_tipo VARCHAR(40) NULL',
    'SELECT 1'
);
PREPARE stmt_equipe_saude_tipo FROM @sql_equipe_saude_tipo;
EXECUTE stmt_equipe_saude_tipo;
DEALLOCATE PREPARE stmt_equipe_saude_tipo;

SET @has_foto_url := (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'jovens'
      AND COLUMN_NAME = 'foto_url'
);
SET @sql_foto_url := IF(
    @has_foto_url = 0,
    'ALTER TABLE jovens ADD COLUMN foto_url VARCHAR(255) NULL',
    'SELECT 1'
);
PREPARE stmt_foto_url FROM @sql_foto_url;
EXECUTE stmt_foto_url;
DEALLOCATE PREPARE stmt_foto_url;

CREATE TABLE IF NOT EXISTS jovens_atualizacao_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    jovem_id INT NOT NULL,
    ejc_id INT NULL,
    montagem_id INT NULL,
    equipe_id INT NULL,
    token VARCHAR(128) NOT NULL,
    atualizado TINYINT(1) NOT NULL DEFAULT 0,
    usado_em DATETIME NULL,
    invalidado_em DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_jovens_atualizacao_token (token),
    UNIQUE KEY uniq_jovens_atualizacao_contexto (tenant_id, jovem_id, ejc_id, montagem_id, equipe_id),
    KEY idx_jovens_atualizacao_tokens_jovem (tenant_id, jovem_id),
    KEY idx_jovens_atualizacao_tokens_equipe (tenant_id, ejc_id, montagem_id, equipe_id)
);

CREATE TABLE IF NOT EXISTS jovens_atualizacao_solicitacoes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    token_id INT NULL,
    jovem_id INT NOT NULL,
    tipo VARCHAR(40) NOT NULL,
    pergunta VARCHAR(255) NOT NULL,
    resposta VARCHAR(40) NOT NULL,
    dados_json JSON NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'pendente',
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    avaliado_em DATETIME NULL,
    avaliado_por INT NULL,
    observacao_admin TEXT NULL,
    KEY idx_jovens_atualizacao_solicitacoes_status (tenant_id, status, criado_em),
    KEY idx_jovens_atualizacao_solicitacoes_jovem (tenant_id, jovem_id)
);
