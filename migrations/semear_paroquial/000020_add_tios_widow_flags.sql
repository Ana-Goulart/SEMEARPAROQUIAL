SET @has_column := (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'tios_casais'
      AND COLUMN_NAME = 'tio_viuvo'
);
SET @sql := IF(
    @has_column = 0,
    'ALTER TABLE tios_casais ADD COLUMN tio_viuvo TINYINT(1) NOT NULL DEFAULT 0 AFTER data_nascimento_tio',
    'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_column := (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'tios_casais'
      AND COLUMN_NAME = 'tia_viuva'
);
SET @sql := IF(
    @has_column = 0,
    'ALTER TABLE tios_casais ADD COLUMN tia_viuva TINYINT(1) NOT NULL DEFAULT 0 AFTER data_nascimento_tia',
    'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
