-- Garante a estrutura usada pela montagem de encontro sem depender de ALTER TABLE em requisições da aplicação.

SET @has_column := (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'montagem_membros'
      AND COLUMN_NAME = 'tio_casal_id'
);
SET @sql := IF(@has_column = 0, 'ALTER TABLE montagem_membros ADD COLUMN tio_casal_id INT NULL AFTER jovem_id', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_index := (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'montagem_membros'
      AND INDEX_NAME = 'idx_montagem_membros_tio_casal'
);
SET @sql := IF(@has_index = 0, 'ALTER TABLE montagem_membros ADD KEY idx_montagem_membros_tio_casal (tio_casal_id)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_column := (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'montagem_membros'
      AND COLUMN_NAME = 'status_ligacao'
);
SET @sql := IF(@has_column = 0, 'ALTER TABLE montagem_membros ADD COLUMN status_ligacao ENUM(''ACEITOU'',''RECUSOU'',''LIGAR_MAIS_TARDE'',''TELEFONE_INCORRETO'') NULL AFTER jovem_id', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_column := (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'montagem_membros'
      AND COLUMN_NAME = 'motivo_recusa'
);
SET @sql := IF(@has_column = 0, 'ALTER TABLE montagem_membros ADD COLUMN motivo_recusa TEXT NULL AFTER status_ligacao', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_column := (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'montagem_membros'
      AND COLUMN_NAME = 'eh_substituicao'
);
SET @sql := IF(@has_column = 0, 'ALTER TABLE montagem_membros ADD COLUMN eh_substituicao TINYINT(1) NOT NULL DEFAULT 0 AFTER motivo_recusa', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_column := (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'montagem_membros'
      AND COLUMN_NAME = 'ordem_reserva'
);
SET @sql := IF(@has_column = 0, 'ALTER TABLE montagem_membros ADD COLUMN ordem_reserva INT NULL AFTER eh_substituicao', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_column := (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'montagem_membros'
      AND COLUMN_NAME = 'nome_externo'
);
SET @sql := IF(@has_column = 0, 'ALTER TABLE montagem_membros ADD COLUMN nome_externo VARCHAR(180) NULL AFTER eh_substituicao', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_column := (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'montagem_membros'
      AND COLUMN_NAME = 'telefone_externo'
);
SET @sql := IF(@has_column = 0, 'ALTER TABLE montagem_membros ADD COLUMN telefone_externo VARCHAR(80) NULL AFTER nome_externo', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

ALTER TABLE montagem_membros MODIFY COLUMN jovem_id INT NULL;
ALTER TABLE montagem_membros MODIFY COLUMN status_ligacao ENUM('ACEITOU','RECUSOU','LIGAR_MAIS_TARDE','TELEFONE_INCORRETO') NULL;
ALTER TABLE montagem_membros MODIFY COLUMN telefone_externo VARCHAR(80) NULL;
ALTER TABLE montagem_membros MODIFY COLUMN ordem_reserva INT NULL;
