CREATE TABLE IF NOT EXISTS usuario_release_notices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    usuario_id INT NOT NULL,
    release_version VARCHAR(30) NOT NULL,
    acknowledged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_usuario_release_notice (tenant_id, usuario_id, release_version),
    KEY idx_usuario_release_notices_usuario (tenant_id, usuario_id),
    KEY idx_usuario_release_notices_version (release_version)
);
