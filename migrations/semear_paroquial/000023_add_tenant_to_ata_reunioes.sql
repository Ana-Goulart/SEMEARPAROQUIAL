CREATE TABLE IF NOT EXISTS ata_reunioes_pastas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    nome VARCHAR(120) NOT NULL,
    tipo ENUM('ANO','MES') NOT NULL,
    parent_id INT NULL,
    ordem INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_ata_pastas_tenant (tenant_id),
    UNIQUE KEY uniq_ata_pasta_tenant_nome_parent (tenant_id, nome, parent_id),
    CONSTRAINT fk_ata_pasta_parent FOREIGN KEY (parent_id) REFERENCES ata_reunioes_pastas(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ata_reunioes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    titulo VARCHAR(255) NULL,
    data_reuniao DATE NOT NULL,
    horario TIME NULL,
    pasta_id INT NULL,
    observacoes_gerais TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_ata_reunioes_tenant (tenant_id)
);

CREATE TABLE IF NOT EXISTS ata_reuniao_presencas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    ata_id INT NOT NULL,
    usuario_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_ata_presencas_tenant (tenant_id),
    UNIQUE KEY uniq_ata_usuario (ata_id, usuario_id),
    CONSTRAINT fk_ata_presenca_ata FOREIGN KEY (ata_id) REFERENCES ata_reunioes(id) ON DELETE CASCADE,
    CONSTRAINT fk_ata_presenca_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ata_reuniao_pautas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    ata_id INT NOT NULL,
    ordem INT NOT NULL DEFAULT 1,
    titulo VARCHAR(255) NOT NULL,
    decisoes TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_ata_pautas_tenant (tenant_id),
    CONSTRAINT fk_ata_pauta_ata FOREIGN KEY (ata_id) REFERENCES ata_reunioes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ata_reuniao_tarefas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    ata_id INT NOT NULL,
    pauta_id INT NULL,
    descricao TEXT NOT NULL,
    responsavel_usuario_id INT NULL,
    responsavel_funcao_id INT NULL,
    prazo DATE NULL,
    status ENUM('PENDENTE','CONCLUIDA') NOT NULL DEFAULT 'PENDENTE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_ata_tarefas_tenant (tenant_id),
    CONSTRAINT fk_ata_tarefa_ata FOREIGN KEY (ata_id) REFERENCES ata_reunioes(id) ON DELETE CASCADE,
    CONSTRAINT fk_ata_tarefa_usuario FOREIGN KEY (responsavel_usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL
);

SET @has_ata_pastas_tenant := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ata_reunioes_pastas' AND COLUMN_NAME = 'tenant_id'
);
SET @sql := IF(@has_ata_pastas_tenant = 0, 'ALTER TABLE ata_reunioes_pastas ADD COLUMN tenant_id INT NULL AFTER id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_ata_tenant := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ata_reunioes' AND COLUMN_NAME = 'tenant_id'
);
SET @sql := IF(@has_ata_tenant = 0, 'ALTER TABLE ata_reunioes ADD COLUMN tenant_id INT NULL AFTER id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_ata_presencas_tenant := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ata_reuniao_presencas' AND COLUMN_NAME = 'tenant_id'
);
SET @sql := IF(@has_ata_presencas_tenant = 0, 'ALTER TABLE ata_reuniao_presencas ADD COLUMN tenant_id INT NULL AFTER id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_ata_pautas_tenant := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ata_reuniao_pautas' AND COLUMN_NAME = 'tenant_id'
);
SET @sql := IF(@has_ata_pautas_tenant = 0, 'ALTER TABLE ata_reuniao_pautas ADD COLUMN tenant_id INT NULL AFTER id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_ata_tarefas_tenant := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ata_reuniao_tarefas' AND COLUMN_NAME = 'tenant_id'
);
SET @sql := IF(@has_ata_tarefas_tenant = 0, 'ALTER TABLE ata_reuniao_tarefas ADD COLUMN tenant_id INT NULL AFTER id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE ata_reunioes_pastas SET tenant_id = 1 WHERE tenant_id IS NULL;

UPDATE ata_reunioes a
LEFT JOIN ata_reunioes_pastas p ON p.id = a.pasta_id
SET a.tenant_id = COALESCE(p.tenant_id, 1)
WHERE a.tenant_id IS NULL;

UPDATE ata_reuniao_presencas ap
JOIN ata_reunioes a ON a.id = ap.ata_id
SET ap.tenant_id = a.tenant_id
WHERE ap.tenant_id IS NULL;

UPDATE ata_reuniao_pautas p
JOIN ata_reunioes a ON a.id = p.ata_id
SET p.tenant_id = a.tenant_id
WHERE p.tenant_id IS NULL;

UPDATE ata_reuniao_tarefas t
JOIN ata_reunioes a ON a.id = t.ata_id
SET t.tenant_id = a.tenant_id
WHERE t.tenant_id IS NULL;

UPDATE ata_reuniao_presencas SET tenant_id = 1 WHERE tenant_id IS NULL;
UPDATE ata_reuniao_pautas SET tenant_id = 1 WHERE tenant_id IS NULL;
UPDATE ata_reuniao_tarefas SET tenant_id = 1 WHERE tenant_id IS NULL;

SET @has_old_ata_pasta_unique := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ata_reunioes_pastas' AND INDEX_NAME = 'uniq_ata_pasta_nome_parent'
);
SET @sql := IF(@has_old_ata_pasta_unique > 0, 'ALTER TABLE ata_reunioes_pastas DROP INDEX uniq_ata_pasta_nome_parent', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_ata_pastas_tenant_idx := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ata_reunioes_pastas' AND INDEX_NAME = 'idx_ata_pastas_tenant'
);
SET @sql := IF(@has_ata_pastas_tenant_idx = 0, 'ALTER TABLE ata_reunioes_pastas ADD KEY idx_ata_pastas_tenant (tenant_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_ata_pastas_unique := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ata_reunioes_pastas' AND INDEX_NAME = 'uniq_ata_pasta_tenant_nome_parent'
);
SET @sql := IF(@has_ata_pastas_unique = 0, 'ALTER TABLE ata_reunioes_pastas ADD UNIQUE KEY uniq_ata_pasta_tenant_nome_parent (tenant_id, nome, parent_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_ata_idx := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ata_reunioes' AND INDEX_NAME = 'idx_ata_reunioes_tenant'
);
SET @sql := IF(@has_ata_idx = 0, 'ALTER TABLE ata_reunioes ADD KEY idx_ata_reunioes_tenant (tenant_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_ata_presencas_idx := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ata_reuniao_presencas' AND INDEX_NAME = 'idx_ata_presencas_tenant'
);
SET @sql := IF(@has_ata_presencas_idx = 0, 'ALTER TABLE ata_reuniao_presencas ADD KEY idx_ata_presencas_tenant (tenant_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_ata_pautas_idx := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ata_reuniao_pautas' AND INDEX_NAME = 'idx_ata_pautas_tenant'
);
SET @sql := IF(@has_ata_pautas_idx = 0, 'ALTER TABLE ata_reuniao_pautas ADD KEY idx_ata_pautas_tenant (tenant_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_ata_tarefas_idx := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ata_reuniao_tarefas' AND INDEX_NAME = 'idx_ata_tarefas_tenant'
);
SET @sql := IF(@has_ata_tarefas_idx = 0, 'ALTER TABLE ata_reuniao_tarefas ADD KEY idx_ata_tarefas_tenant (tenant_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

ALTER TABLE ata_reunioes_pastas MODIFY COLUMN tenant_id INT NOT NULL;
ALTER TABLE ata_reunioes MODIFY COLUMN tenant_id INT NOT NULL;
ALTER TABLE ata_reuniao_presencas MODIFY COLUMN tenant_id INT NOT NULL;
ALTER TABLE ata_reuniao_pautas MODIFY COLUMN tenant_id INT NOT NULL;
ALTER TABLE ata_reuniao_tarefas MODIFY COLUMN tenant_id INT NOT NULL;
