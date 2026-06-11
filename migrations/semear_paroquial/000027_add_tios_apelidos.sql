SET @has_apelido_tio := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tios_casais' AND COLUMN_NAME = 'apelido_tio'
);
SET @sql_apelido_tio := IF(@has_apelido_tio = 0, 'ALTER TABLE tios_casais ADD COLUMN apelido_tio VARCHAR(120) NULL AFTER nome_tio', 'SELECT 1');
PREPARE stmt_apelido_tio FROM @sql_apelido_tio;
EXECUTE stmt_apelido_tio;
DEALLOCATE PREPARE stmt_apelido_tio;

SET @has_apelido_tia := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tios_casais' AND COLUMN_NAME = 'apelido_tia'
);
SET @sql_apelido_tia := IF(@has_apelido_tia = 0, 'ALTER TABLE tios_casais ADD COLUMN apelido_tia VARCHAR(120) NULL AFTER nome_tia', 'SELECT 1');
PREPARE stmt_apelido_tia FROM @sql_apelido_tia;
EXECUTE stmt_apelido_tia;
DEALLOCATE PREPARE stmt_apelido_tia;
