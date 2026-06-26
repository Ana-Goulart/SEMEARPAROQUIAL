-- Migration 000031: Fix duplicate tokens in jovens_atualizacao_tokens and tios_atualizacao_tokens
-- Causa: UNIQUE KEY com colunas NULL não garante unicidade no MySQL (NULL != NULL na unicidade).
-- Solução: limpar duplicatas, recriar índices usando functional indexes com COALESCE.
-- MySQL 8.0.13+ requerido para functional indexes. Idempotente.

-- ============================================================
-- 1. Limpar duplicatas em jovens_atualizacao_tokens
--    Por grupo (tenant_id, jovem_id, ejc_id, montagem_id, equipe_id):
--    manter o token com atualizado=1 se existir, senão o de menor id.
--    Nunca deletar tokens com atualizado=1.
-- ============================================================

DELETE t1
FROM jovens_atualizacao_tokens t1
JOIN jovens_atualizacao_tokens t2
  ON  t2.tenant_id     = t1.tenant_id
  AND (t2.jovem_id    <=> t1.jovem_id)
  AND (t2.ejc_id      <=> t1.ejc_id)
  AND (t2.montagem_id <=> t1.montagem_id)
  AND (t2.equipe_id   <=> t1.equipe_id)
  AND (
      (t2.atualizado = 1 AND t1.atualizado = 0)
      OR
      (t2.atualizado = t1.atualizado AND t2.id < t1.id)
  )
WHERE t1.atualizado = 0;

-- ============================================================
-- 2. Limpar duplicatas em tios_atualizacao_tokens
--    Por grupo (tenant_id, casal_id, montagem_id, equipe_id).
-- ============================================================

DELETE t1
FROM tios_atualizacao_tokens t1
JOIN tios_atualizacao_tokens t2
  ON  t2.tenant_id     = t1.tenant_id
  AND (t2.casal_id    <=> t1.casal_id)
  AND (t2.montagem_id <=> t1.montagem_id)
  AND (t2.equipe_id   <=> t1.equipe_id)
  AND (
      (t2.atualizado = 1 AND t1.atualizado = 0)
      OR
      (t2.atualizado = t1.atualizado AND t2.id < t1.id)
  )
WHERE t1.atualizado = 0;

-- ============================================================
-- 3. Recriar índices de unicidade via stored procedure (idempotente)
-- ============================================================

DROP PROCEDURE IF EXISTS _mig031;

DELIMITER $$
CREATE PROCEDURE _mig031()
BEGIN
    DECLARE v_exists INT DEFAULT 0;

    -- jovens: dropar índice antigo se ainda existir
    SELECT COUNT(*) INTO v_exists
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'jovens_atualizacao_tokens'
      AND INDEX_NAME   = 'uniq_jovens_atualizacao_contexto';

    IF v_exists > 0 THEN
        ALTER TABLE jovens_atualizacao_tokens
            DROP INDEX uniq_jovens_atualizacao_contexto;
    END IF;

    -- jovens: remover colunas geradas se existirem (de tentativas anteriores)
    SELECT COUNT(*) INTO v_exists
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'jovens_atualizacao_tokens'
      AND COLUMN_NAME  = 'ejc_id_nn';

    IF v_exists > 0 THEN
        ALTER TABLE jovens_atualizacao_tokens DROP COLUMN ejc_id_nn;
    END IF;

    SELECT COUNT(*) INTO v_exists
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'jovens_atualizacao_tokens'
      AND COLUMN_NAME  = 'montagem_id_nn';

    IF v_exists > 0 THEN
        ALTER TABLE jovens_atualizacao_tokens DROP COLUMN montagem_id_nn;
    END IF;

    SELECT COUNT(*) INTO v_exists
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'jovens_atualizacao_tokens'
      AND COLUMN_NAME  = 'equipe_id_nn';

    IF v_exists > 0 THEN
        ALTER TABLE jovens_atualizacao_tokens DROP COLUMN equipe_id_nn;
    END IF;

    -- jovens: criar novo functional unique index
    SELECT COUNT(*) INTO v_exists
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'jovens_atualizacao_tokens'
      AND INDEX_NAME   = 'uniq_jovens_atualizacao_contexto';

    IF v_exists = 0 THEN
        ALTER TABLE jovens_atualizacao_tokens
            ADD UNIQUE INDEX uniq_jovens_atualizacao_contexto
            (tenant_id, jovem_id, (COALESCE(ejc_id, 0)), (COALESCE(montagem_id, 0)), (COALESCE(equipe_id, 0)));
    END IF;

    -- tios: remover colunas geradas se existirem (de tentativas anteriores)
    SELECT COUNT(*) INTO v_exists
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'tios_atualizacao_tokens'
      AND COLUMN_NAME  = 'montagem_id_nn';

    IF v_exists > 0 THEN
        ALTER TABLE tios_atualizacao_tokens DROP COLUMN montagem_id_nn;
    END IF;

    SELECT COUNT(*) INTO v_exists
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'tios_atualizacao_tokens'
      AND COLUMN_NAME  = 'equipe_id_nn';

    IF v_exists > 0 THEN
        ALTER TABLE tios_atualizacao_tokens DROP COLUMN equipe_id_nn;
    END IF;

    -- tios: criar functional unique index
    SELECT COUNT(*) INTO v_exists
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'tios_atualizacao_tokens'
      AND INDEX_NAME   = 'uniq_tios_atualizacao_contexto';

    IF v_exists = 0 THEN
        ALTER TABLE tios_atualizacao_tokens
            ADD UNIQUE INDEX uniq_tios_atualizacao_contexto
            (tenant_id, casal_id, (COALESCE(montagem_id, 0)), (COALESCE(equipe_id, 0)));
    END IF;

END$$
DELIMITER ;

CALL _mig031();
DROP PROCEDURE IF EXISTS _mig031;
