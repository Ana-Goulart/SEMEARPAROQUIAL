SET @has_possui_carro_tio := (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'tios_casais'
      AND COLUMN_NAME = 'possui_carro_tio'
);

SET @sql_possui_carro_tio := IF(
    @has_possui_carro_tio = 0,
    'ALTER TABLE tios_casais ADD COLUMN possui_carro_tio TINYINT(1) NOT NULL DEFAULT 0 AFTER qual_deficiencia_tio',
    'SELECT 1'
);
PREPARE stmt FROM @sql_possui_carro_tio;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_possui_carro_tia := (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'tios_casais'
      AND COLUMN_NAME = 'possui_carro_tia'
);

SET @sql_possui_carro_tia := IF(
    @has_possui_carro_tia = 0,
    'ALTER TABLE tios_casais ADD COLUMN possui_carro_tia TINYINT(1) NOT NULL DEFAULT 0 AFTER qual_deficiencia_tia',
    'SELECT 1'
);
PREPARE stmt FROM @sql_possui_carro_tia;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
