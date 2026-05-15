-- Garante que a função padrão Coordenação esteja presente em todas as equipes.

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
