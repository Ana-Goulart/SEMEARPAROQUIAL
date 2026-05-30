ALTER TABLE jovens
    ADD COLUMN cpf TEXT NULL AFTER telefone_hash,
    ADD COLUMN cpf_hash CHAR(64) NULL AFTER cpf,
    ADD KEY idx_jovens_tenant_cpf_hash (tenant_id, cpf_hash);
