-- Corrige serviços de tios que foram gravados com ejc_id apontando para montagens.id.
UPDATE tios_casal_servicos correto
JOIN tios_casal_servicos errado
  ON errado.tenant_id = correto.tenant_id
 AND errado.casal_id = correto.casal_id
 AND errado.equipe_id = correto.equipe_id
JOIN montagens m
  ON m.id = errado.ejc_id
 AND m.tenant_id = errado.tenant_id
JOIN ejc e
  ON e.numero = m.numero_ejc
 AND e.tenant_id = m.tenant_id
 AND e.id = correto.ejc_id
SET correto.nome_tio_snapshot = COALESCE(correto.nome_tio_snapshot, errado.nome_tio_snapshot),
    correto.telefone_tio_snapshot = COALESCE(correto.telefone_tio_snapshot, errado.telefone_tio_snapshot),
    correto.nome_tia_snapshot = COALESCE(correto.nome_tia_snapshot, errado.nome_tia_snapshot),
    correto.telefone_tia_snapshot = COALESCE(correto.telefone_tia_snapshot, errado.telefone_tia_snapshot);

DELETE errado
FROM tios_casal_servicos errado
JOIN montagens m
  ON m.id = errado.ejc_id
 AND m.tenant_id = errado.tenant_id
JOIN ejc e
  ON e.numero = m.numero_ejc
 AND e.tenant_id = m.tenant_id
JOIN tios_casal_servicos correto
  ON correto.tenant_id = errado.tenant_id
 AND correto.casal_id = errado.casal_id
 AND correto.equipe_id = errado.equipe_id
 AND correto.ejc_id = e.id;

UPDATE tios_casal_servicos ts
JOIN montagens m
  ON m.id = ts.ejc_id
 AND m.tenant_id = ts.tenant_id
JOIN ejc e
  ON e.numero = m.numero_ejc
 AND e.tenant_id = m.tenant_id
LEFT JOIN tios_casal_servicos correto
  ON correto.tenant_id = ts.tenant_id
 AND correto.casal_id = ts.casal_id
 AND correto.equipe_id = ts.equipe_id
 AND correto.ejc_id = e.id
 AND correto.id <> ts.id
SET ts.ejc_id = e.id
WHERE correto.id IS NULL;
