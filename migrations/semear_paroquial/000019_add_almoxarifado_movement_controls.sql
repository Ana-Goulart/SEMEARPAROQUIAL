SET @has_column := (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'almoxarifado_itens'
      AND COLUMN_NAME = 'permite_emprestimo_doacao'
);
SET @sql := IF(
    @has_column = 0,
    'ALTER TABLE almoxarifado_itens ADD COLUMN permite_emprestimo_doacao TINYINT(1) NOT NULL DEFAULT 1 AFTER localizacao',
    'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_column := (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'almoxarifado_movimentacoes'
      AND COLUMN_NAME = 'telefone_responsavel'
);
SET @sql := IF(
    @has_column = 0,
    'ALTER TABLE almoxarifado_movimentacoes ADD COLUMN telefone_responsavel VARCHAR(40) NULL AFTER nome_responsavel',
    'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
