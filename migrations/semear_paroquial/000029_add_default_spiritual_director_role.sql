CREATE TABLE IF NOT EXISTS funcoes_dirigencia (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    nome VARCHAR(160) NOT NULL,
    descricao TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_funcoes_dirigencia_tenant (tenant_id),
    UNIQUE KEY uniq_funcoes_dirigencia_tenant_nome (tenant_id, nome)
);

CREATE TABLE IF NOT EXISTS tenant_module_users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    module_code VARCHAR(80) NOT NULL,
    nome_completo VARCHAR(160) NOT NULL,
    email VARCHAR(180) NOT NULL,
    senha_hash VARCHAR(255) NOT NULL,
    grupo VARCHAR(100) NOT NULL DEFAULT 'Tios',
    ativo TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_tenant_module_email (tenant_id, module_code, email),
    KEY idx_tenant_module_users_tenant (tenant_id)
);

CREATE TABLE IF NOT EXISTS funcoes_dirigencia_usuarios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    funcao_id INT NOT NULL,
    usuario_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_funcao_usuario (funcao_id, usuario_id),
    KEY idx_fd_usuarios_tenant (tenant_id)
);

CREATE TABLE IF NOT EXISTS funcoes_dirigencia_menus (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    funcao_id INT NOT NULL,
    menu_key VARCHAR(40) NOT NULL,
    access_level ENUM('view', 'edit') NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_fd_menu_access (tenant_id, funcao_id, menu_key),
    KEY idx_fd_menu_access_tenant_menu (tenant_id, menu_key)
);

INSERT INTO funcoes_dirigencia (tenant_id, nome, descricao)
SELECT tenants.tenant_id,
       'Diretor Espiritual/Padre',
       'Função padrão do sistema com acesso de edição a todos os menus.'
FROM (
    SELECT id AS tenant_id FROM tenants_ejc
    UNION
    SELECT tenant_id FROM usuarios WHERE tenant_id IS NOT NULL
    UNION
    SELECT tenant_id FROM tenant_module_users WHERE tenant_id IS NOT NULL
) tenants
WHERE tenants.tenant_id IS NOT NULL
  AND NOT EXISTS (
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
