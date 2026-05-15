-- Remove papéis de coordenação com grafia incorreta/duplicada após padronizar para Coordenador.

UPDATE equipes_funcoes
SET papel_base = 'Coordenador'
WHERE LOWER(COALESCE(papel_base, '')) IN (
    'cordenadora',
    'cordenador',
    'cordenadores',
    'coordenadora',
    'coordenadores'
);

UPDATE equipes_funcoes_padrao
SET papel_base = 'Coordenador'
WHERE LOWER(COALESCE(papel_base, '')) IN (
    'cordenadora',
    'cordenador',
    'cordenadores',
    'coordenadora',
    'coordenadores'
);

DELETE FROM equipes_papeis
WHERE LOWER(nome) IN (
    'cordenadora',
    'cordenador',
    'cordenadores',
    'coordenadora',
    'coordenadores'
);
