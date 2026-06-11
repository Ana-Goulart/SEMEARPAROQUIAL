SET @has_table_montagem_encontristas_dados := (
    SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'montagem_encontristas_dados'
);

SET @has_montagem_encontristas_cpf := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'montagem_encontristas_dados' AND COLUMN_NAME = 'cpf'
);

SET @sql_montagem_encontristas_cpf := IF(
    @has_table_montagem_encontristas_dados > 0 AND @has_montagem_encontristas_cpf = 0,
    'ALTER TABLE montagem_encontristas_dados ADD COLUMN cpf TEXT NULL AFTER telefone_referencia',
    'SELECT 1'
);
PREPARE stmt_montagem_encontristas_cpf FROM @sql_montagem_encontristas_cpf;
EXECUTE stmt_montagem_encontristas_cpf;
DEALLOCATE PREPARE stmt_montagem_encontristas_cpf;
