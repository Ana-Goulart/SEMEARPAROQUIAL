SET @has_cpf_tio := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tios_casais' AND COLUMN_NAME = 'cpf_tio'
);
SET @sql_cpf_tio := IF(@has_cpf_tio = 0, 'ALTER TABLE tios_casais ADD COLUMN cpf_tio TEXT NULL', 'SELECT 1');
PREPARE stmt_cpf_tio FROM @sql_cpf_tio;
EXECUTE stmt_cpf_tio;
DEALLOCATE PREPARE stmt_cpf_tio;

SET @has_cpf_tio_hash := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tios_casais' AND COLUMN_NAME = 'cpf_tio_hash'
);
SET @sql_cpf_tio_hash := IF(@has_cpf_tio_hash = 0, 'ALTER TABLE tios_casais ADD COLUMN cpf_tio_hash CHAR(64) NULL', 'SELECT 1');
PREPARE stmt_cpf_tio_hash FROM @sql_cpf_tio_hash;
EXECUTE stmt_cpf_tio_hash;
DEALLOCATE PREPARE stmt_cpf_tio_hash;

SET @has_cpf_tia := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tios_casais' AND COLUMN_NAME = 'cpf_tia'
);
SET @sql_cpf_tia := IF(@has_cpf_tia = 0, 'ALTER TABLE tios_casais ADD COLUMN cpf_tia TEXT NULL', 'SELECT 1');
PREPARE stmt_cpf_tia FROM @sql_cpf_tia;
EXECUTE stmt_cpf_tia;
DEALLOCATE PREPARE stmt_cpf_tia;

SET @has_cpf_tia_hash := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tios_casais' AND COLUMN_NAME = 'cpf_tia_hash'
);
SET @sql_cpf_tia_hash := IF(@has_cpf_tia_hash = 0, 'ALTER TABLE tios_casais ADD COLUMN cpf_tia_hash CHAR(64) NULL', 'SELECT 1');
PREPARE stmt_cpf_tia_hash FROM @sql_cpf_tia_hash;
EXECUTE stmt_cpf_tia_hash;
DEALLOCATE PREPARE stmt_cpf_tia_hash;

CREATE TABLE IF NOT EXISTS tios_atualizacao_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    casal_id INT NOT NULL,
    montagem_id INT NULL,
    equipe_id INT NULL,
    token VARCHAR(128) NOT NULL,
    atualizado TINYINT(1) NOT NULL DEFAULT 0,
    usado_em DATETIME NULL,
    invalidado_em DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_tios_atualizacao_token (token),
    KEY idx_tios_atualizacao_casal (tenant_id, casal_id),
    KEY idx_tios_atualizacao_equipe (tenant_id, montagem_id, equipe_id)
);
