-- Define Coordenação como a única função padrão global e aplica em todas as equipes.
-- Funções específicas por equipe continuam preservadas.

UPDATE equipes_papeis
SET nome = 'Coordenador'
WHERE LOWER(nome) IN ('cordenadora', 'coordenadora', 'cordenador');

INSERT INTO equipes_papeis (tenant_id, nome, ordem)
SELECT tenant_id, 'Coordenador', 1
FROM (
    SELECT DISTINCT tenant_id
    FROM equipes
) tenants
WHERE NOT EXISTS (
    SELECT 1
    FROM equipes_papeis ep
    WHERE ep.tenant_id = tenants.tenant_id
      AND LOWER(ep.nome) = 'coordenador'
);

UPDATE equipes_papeis
SET ordem = 1
WHERE LOWER(nome) = 'coordenador';

DELETE FROM equipes_funcoes
WHERE origem_padrao_id IS NOT NULL;

DELETE FROM equipes_funcoes_padrao;

INSERT INTO equipes_funcoes_padrao (tenant_id, nome, papel_base)
SELECT tenant_id, 'Coordenação', 'Coordenador'
FROM (
    SELECT DISTINCT tenant_id
    FROM equipes
) tenants;

INSERT INTO equipes_funcoes (tenant_id, equipe_id, nome, papel_base, origem_padrao_id)
SELECT e.tenant_id,
       e.id,
       'Coordenação',
       'Coordenador',
       fp.id
FROM equipes e
JOIN equipes_funcoes_padrao fp
  ON fp.tenant_id = e.tenant_id
 AND fp.nome = 'Coordenação'
 AND fp.papel_base = 'Coordenador'
WHERE NOT EXISTS (
    SELECT 1
    FROM equipes_funcoes ef
    WHERE ef.tenant_id = e.tenant_id
      AND ef.equipe_id = e.id
      AND ef.nome = 'Coordenação'
      AND COALESCE(ef.papel_base, 'Membro') = 'Coordenador'
);
