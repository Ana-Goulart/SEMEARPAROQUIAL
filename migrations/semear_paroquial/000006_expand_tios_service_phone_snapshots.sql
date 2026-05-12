-- Telefones dos tios podem estar criptografados; VARCHAR(30) não comporta o valor enc:v1 completo.
ALTER TABLE tios_casal_servicos MODIFY telefone_tio_snapshot TEXT NULL;
ALTER TABLE tios_casal_servicos MODIFY telefone_tia_snapshot TEXT NULL;
ALTER TABLE tios_casal_servicos_historico MODIFY telefone_tio_snapshot TEXT NULL;
ALTER TABLE tios_casal_servicos_historico MODIFY telefone_tia_snapshot TEXT NULL;
