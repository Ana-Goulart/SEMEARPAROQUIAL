CREATE TABLE IF NOT EXISTS equipes_atualizacao_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    tipo VARCHAR(20) NOT NULL DEFAULT 'edicao',
    ejc_id INT NULL,
    montagem_id INT NULL,
    equipe_id INT NOT NULL,
    token VARCHAR(128) NOT NULL,
    invalidado_em DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_equipes_atualizacao_token (token),
    KEY idx_equipes_atualizacao_contexto (tenant_id, tipo, ejc_id, montagem_id, equipe_id),
    KEY idx_equipes_atualizacao_equipe (tenant_id, equipe_id)
);
