CREATE TABLE IF NOT EXISTS funcoes_dirigencia_menus (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    funcao_id INT NOT NULL,
    menu_key VARCHAR(40) NOT NULL,
    access_level ENUM('view', 'edit') NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_fd_menu_access (tenant_id, funcao_id, menu_key),
    KEY idx_fd_menu_access_tenant_menu (tenant_id, menu_key),
    CONSTRAINT fk_fd_menu_access_funcao
        FOREIGN KEY (funcao_id) REFERENCES funcoes_dirigencia(id)
        ON DELETE CASCADE
);
