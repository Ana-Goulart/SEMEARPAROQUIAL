-- Ajusta indices unicos legados para respeitar isolamento multi-tenant.
-- Antes, nomes/numeros iguais em tenants diferentes eram bloqueados pelo banco.

SET @has_equipes_nome_unique := (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'equipes'
      AND INDEX_NAME = 'nome'
      AND NON_UNIQUE = 0
);
SET @sql := IF(@has_equipes_nome_unique > 0, 'ALTER TABLE equipes DROP INDEX nome', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_equipes_tenant_nome_unique := (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'equipes'
      AND INDEX_NAME = 'uniq_equipes_tenant_nome'
);
SET @sql := IF(@has_equipes_tenant_nome_unique = 0, 'ALTER TABLE equipes ADD UNIQUE KEY uniq_equipes_tenant_nome (tenant_id, nome)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_ejc_numero_unique := (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'ejc'
      AND INDEX_NAME = 'numero'
      AND NON_UNIQUE = 0
);
SET @sql := IF(@has_ejc_numero_unique > 0, 'ALTER TABLE ejc DROP INDEX numero', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_ejc_tenant_numero_unique := (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'ejc'
      AND INDEX_NAME = 'uniq_ejc_tenant_numero'
);
SET @sql := IF(@has_ejc_tenant_numero_unique = 0, 'ALTER TABLE ejc ADD UNIQUE KEY uniq_ejc_tenant_numero (tenant_id, numero)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_equipes_papeis_nome_unique := (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'equipes_papeis'
      AND INDEX_NAME = 'nome'
      AND NON_UNIQUE = 0
);
SET @sql := IF(@has_equipes_papeis_nome_unique > 0, 'ALTER TABLE equipes_papeis DROP INDEX nome', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_equipes_papeis_tenant_nome_unique := (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'equipes_papeis'
      AND INDEX_NAME = 'uniq_equipes_papeis_tenant_nome'
);
SET @sql := IF(@has_equipes_papeis_tenant_nome_unique = 0, 'ALTER TABLE equipes_papeis ADD UNIQUE KEY uniq_equipes_papeis_tenant_nome (tenant_id, nome)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE equipes_funcoes_padrao
SET papel_base = 'Membro'
WHERE papel_base IS NULL OR TRIM(papel_base) = '';

ALTER TABLE equipes_funcoes_padrao
    MODIFY COLUMN papel_base VARCHAR(50) NOT NULL DEFAULT 'Membro';

SET @has_funcoes_padrao_unique := (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'equipes_funcoes_padrao'
      AND INDEX_NAME = 'unique_funcao_padrao'
      AND NON_UNIQUE = 0
);
SET @sql := IF(@has_funcoes_padrao_unique > 0, 'ALTER TABLE equipes_funcoes_padrao DROP INDEX unique_funcao_padrao', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_funcoes_padrao_tenant_unique := (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'equipes_funcoes_padrao'
      AND INDEX_NAME = 'uniq_funcoes_padrao_tenant_nome_papel'
);
SET @sql := IF(@has_funcoes_padrao_tenant_unique = 0, 'ALTER TABLE equipes_funcoes_padrao ADD UNIQUE KEY uniq_funcoes_padrao_tenant_nome_papel (tenant_id, nome, papel_base)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_equipes_ejc_unique := (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'equipes_ejc'
      AND INDEX_NAME = 'unique_ejc_equipe'
      AND NON_UNIQUE = 0
);
SET @has_equipes_ejc_ejc_idx := (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'equipes_ejc'
      AND INDEX_NAME = 'idx_equipes_ejc_ejc'
);
SET @sql := IF(@has_equipes_ejc_ejc_idx = 0, 'ALTER TABLE equipes_ejc ADD KEY idx_equipes_ejc_ejc (ejc_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(@has_equipes_ejc_unique > 0, 'ALTER TABLE equipes_ejc DROP INDEX unique_ejc_equipe', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_equipes_ejc_tenant_unique := (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'equipes_ejc'
      AND INDEX_NAME = 'uniq_equipes_ejc_tenant_ejc_equipe'
);
SET @sql := IF(@has_equipes_ejc_tenant_unique = 0, 'ALTER TABLE equipes_ejc ADD UNIQUE KEY uniq_equipes_ejc_tenant_ejc_equipe (tenant_id, ejc_id, equipe_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
