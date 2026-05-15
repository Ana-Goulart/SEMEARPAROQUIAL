-- Permite remover uma função padrão de uma equipe específica sem apagar o padrão global.

CREATE TABLE IF NOT EXISTS equipes_funcoes_padrao_exclusoes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    equipe_id INT NOT NULL,
    funcao_padrao_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_eq_funcao_padrao_exclusao (tenant_id, equipe_id, funcao_padrao_id),
    KEY idx_eq_funcao_padrao_exclusoes_tenant (tenant_id),
    KEY idx_eq_funcao_padrao_exclusoes_equipe (equipe_id),
    KEY idx_eq_funcao_padrao_exclusoes_padrao (funcao_padrao_id),
    CONSTRAINT fk_eq_funcao_padrao_exclusoes_equipe
        FOREIGN KEY (equipe_id) REFERENCES equipes(id) ON DELETE CASCADE,
    CONSTRAINT fk_eq_funcao_padrao_exclusoes_padrao
        FOREIGN KEY (funcao_padrao_id) REFERENCES equipes_funcoes_padrao(id) ON DELETE CASCADE
);
