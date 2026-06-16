INSERT INTO funcoes_dirigencia (tenant_id, nome, descricao)
SELECT tenants.tenant_id,
       'Diretor Espiritual/Padre',
       'Função padrão do sistema com acesso de edição a todos os menus.'
FROM (
    SELECT tenant_id
    FROM tenant_module_users
    WHERE tenant_id IS NOT NULL
      AND module_code = 'semear-jovens'
      AND ativo = 1
    UNION
    SELECT tenant_id
    FROM usuarios
    WHERE tenant_id IS NOT NULL
) tenants
WHERE NOT EXISTS (
    SELECT 1
    FROM funcoes_dirigencia fd
    WHERE fd.tenant_id = tenants.tenant_id
      AND LOWER(fd.nome) = LOWER('Diretor Espiritual/Padre')
);

UPDATE funcoes_dirigencia
SET nome = 'Diretor Espiritual/Padre',
    descricao = 'Função padrão do sistema com acesso de edição a todos os menus.'
WHERE LOWER(nome) = LOWER('Diretor Espiritual/Padre');

INSERT IGNORE INTO funcoes_dirigencia_menus (tenant_id, funcao_id, menu_key, access_level)
SELECT fd.tenant_id,
       fd.id,
       menus.menu_key,
       'edit'
FROM funcoes_dirigencia fd
JOIN (
    SELECT 'gerencia' AS menu_key
    UNION ALL SELECT 'encontros'
    UNION ALL SELECT 'outros-ejcs'
    UNION ALL SELECT 'planejamento'
    UNION ALL SELECT 'secretaria'
    UNION ALL SELECT 'financeiro'
    UNION ALL SELECT 'minha-igreja'
) menus
WHERE LOWER(fd.nome) = LOWER('Diretor Espiritual/Padre');

UPDATE funcoes_dirigencia_menus fdm
JOIN funcoes_dirigencia fd
  ON fd.id = fdm.funcao_id
 AND fd.tenant_id = fdm.tenant_id
SET fdm.access_level = 'edit'
WHERE LOWER(fd.nome) = LOWER('Diretor Espiritual/Padre');

INSERT IGNORE INTO funcoes_dirigencia_usuarios (tenant_id, funcao_id, usuario_id)
SELECT fd.tenant_id,
       fd.id,
       u.id
FROM funcoes_dirigencia fd
JOIN tenant_module_users tmu
  ON tmu.tenant_id = fd.tenant_id
 AND tmu.module_code = 'semear-jovens'
 AND tmu.ativo = 1
JOIN usuarios u
  ON u.tenant_id = tmu.tenant_id
 AND LOWER(u.username) = LOWER(tmu.email)
WHERE LOWER(fd.nome) = LOWER('Diretor Espiritual/Padre');
