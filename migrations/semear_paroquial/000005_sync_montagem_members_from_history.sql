-- Materializa na montagem atual os históricos já importados/cadastrados para a mesma edição do EJC.
-- A tela de montar encontro lê montagem_membros; a ficha lê os históricos, então os dois precisam ficar alinhados.

INSERT INTO equipes_funcoes (tenant_id, equipe_id, nome, papel_base)
SELECT eq.tenant_id, eq.id, 'Membro', 'Membro'
FROM equipes eq
LEFT JOIN equipes_funcoes ef
  ON ef.tenant_id = eq.tenant_id
 AND ef.equipe_id = eq.id
 AND LOWER(TRIM(ef.nome)) = 'membro'
 AND COALESCE(ef.papel_base, 'Membro') = 'Membro'
WHERE ef.id IS NULL;

INSERT INTO equipes_funcoes (tenant_id, equipe_id, nome, papel_base)
SELECT DISTINCT ts.tenant_id, ts.equipe_id, 'Tio', 'Tio'
FROM tios_casal_servicos ts
JOIN ejc e
  ON e.id = ts.ejc_id
 AND e.tenant_id = ts.tenant_id
JOIN montagens m
  ON m.tenant_id = ts.tenant_id
 AND m.numero_ejc = e.numero
LEFT JOIN equipes_funcoes ef
  ON ef.tenant_id = ts.tenant_id
 AND ef.equipe_id = ts.equipe_id
 AND LOWER(TRIM(ef.nome)) = 'tio'
 AND COALESCE(ef.papel_base, 'Membro') = 'Tio'
WHERE ef.id IS NULL;

DROP TEMPORARY TABLE IF EXISTS tmp_montagem_historico_jovens;
CREATE TEMPORARY TABLE tmp_montagem_historico_jovens AS
SELECT
    MIN(he.id) AS historico_id,
    m.id AS montagem_id,
    he.jovem_id
FROM montagens m
LEFT JOIN ejc e
  ON e.numero = m.numero_ejc
 AND e.tenant_id = m.tenant_id
JOIN historico_equipes he
  ON he.tenant_id = m.tenant_id
 AND he.jovem_id IS NOT NULL
 AND (
        he.ejc_id = e.id
     OR he.edicao_ejc LIKE CONCAT(m.numero_ejc, '%EJC (Montagem)%')
     OR he.edicao_ejc LIKE CONCAT(m.numero_ejc, '%EJC%')
 )
GROUP BY m.id, he.jovem_id;

INSERT INTO montagem_membros (tenant_id, montagem_id, equipe_id, funcao_id, jovem_id, eh_substituicao)
SELECT
    m.tenant_id,
    m.id,
    eq.id,
    ef.id,
    he.jovem_id,
    0
FROM tmp_montagem_historico_jovens tmp
JOIN montagens m
  ON m.id = tmp.montagem_id
JOIN historico_equipes he
  ON he.id = tmp.historico_id
JOIN equipes eq
  ON eq.tenant_id = m.tenant_id
 AND LOWER(TRIM(eq.nome)) = LOWER(TRIM(he.equipe))
JOIN equipes_funcoes ef
  ON ef.tenant_id = m.tenant_id
 AND ef.equipe_id = eq.id
 AND LOWER(TRIM(ef.nome)) = LOWER(TRIM(COALESCE(NULLIF(he.subfuncao, ''), NULLIF(he.papel, ''), 'Membro')))
 AND COALESCE(ef.papel_base, 'Membro') = COALESCE(NULLIF(he.papel, ''), 'Membro')
LEFT JOIN montagem_membros mm
  ON mm.tenant_id = m.tenant_id
 AND mm.montagem_id = m.id
 AND mm.jovem_id = he.jovem_id
WHERE mm.id IS NULL;

DROP TEMPORARY TABLE IF EXISTS tmp_montagem_historico_tios;
CREATE TEMPORARY TABLE tmp_montagem_historico_tios AS
SELECT
    MIN(ts.id) AS servico_id,
    m.id AS montagem_id,
    ts.casal_id
FROM montagens m
JOIN ejc e
  ON e.numero = m.numero_ejc
 AND e.tenant_id = m.tenant_id
JOIN tios_casal_servicos ts
  ON ts.tenant_id = m.tenant_id
 AND ts.ejc_id = e.id
GROUP BY m.id, ts.casal_id;

INSERT INTO montagem_membros (tenant_id, montagem_id, equipe_id, funcao_id, jovem_id, tio_casal_id, eh_substituicao)
SELECT
    m.tenant_id,
    m.id,
    ts.equipe_id,
    ef.id,
    NULL,
    ts.casal_id,
    0
FROM tmp_montagem_historico_tios tmp
JOIN montagens m
  ON m.id = tmp.montagem_id
JOIN tios_casal_servicos ts
  ON ts.id = tmp.servico_id
JOIN equipes_funcoes ef
  ON ef.tenant_id = m.tenant_id
 AND ef.equipe_id = ts.equipe_id
 AND LOWER(TRIM(ef.nome)) = 'tio'
 AND COALESCE(ef.papel_base, 'Membro') = 'Tio'
LEFT JOIN montagem_membros mm
  ON mm.tenant_id = m.tenant_id
 AND mm.montagem_id = m.id
 AND mm.tio_casal_id = ts.casal_id
WHERE mm.id IS NULL;

DROP TEMPORARY TABLE IF EXISTS tmp_montagem_historico_jovens;
DROP TEMPORARY TABLE IF EXISTS tmp_montagem_historico_tios;
