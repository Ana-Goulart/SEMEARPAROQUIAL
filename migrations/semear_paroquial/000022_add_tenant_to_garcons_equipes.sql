CREATE TABLE IF NOT EXISTS garcons_equipes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    ejc_numero INT NOT NULL,
    outro_ejc_id INT NOT NULL,
    reserva_ativa TINYINT(1) NOT NULL DEFAULT 0,
    data_inicio DATE NULL,
    data_fim DATE NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_garcons_equipes_tenant (tenant_id),
    CONSTRAINT fk_garcons_equipe_outro_ejc FOREIGN KEY (outro_ejc_id) REFERENCES outros_ejcs(id) ON DELETE RESTRICT
);

SET @has_garcons_equipes_tenant := (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'garcons_equipes'
      AND COLUMN_NAME = 'tenant_id'
);

SET @sql := IF(
    @has_garcons_equipes_tenant = 0,
    'ALTER TABLE garcons_equipes ADD COLUMN tenant_id INT NULL AFTER id',
    'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE garcons_equipes ge
LEFT JOIN outros_ejcs oe ON oe.id = ge.outro_ejc_id
SET ge.tenant_id = COALESCE(oe.tenant_id, 1)
WHERE ge.tenant_id IS NULL;

ALTER TABLE garcons_equipes MODIFY COLUMN tenant_id INT NOT NULL;

SET @has_garcons_equipes_tenant_idx := (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'garcons_equipes'
      AND INDEX_NAME = 'idx_garcons_equipes_tenant'
);

SET @sql := IF(
    @has_garcons_equipes_tenant_idx = 0,
    'ALTER TABLE garcons_equipes ADD KEY idx_garcons_equipes_tenant (tenant_id)',
    'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
