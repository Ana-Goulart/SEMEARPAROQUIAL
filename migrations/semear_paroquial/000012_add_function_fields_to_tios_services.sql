-- Guarda a função base e a subfunção escolhidas ao registrar um casal de tios em uma equipe.

ALTER TABLE tios_casal_servicos
    ADD COLUMN papel VARCHAR(50) NULL AFTER ejc_id,
    ADD COLUMN subfuncao VARCHAR(120) NULL AFTER papel;

ALTER TABLE tios_casal_servicos_historico
    ADD COLUMN papel VARCHAR(50) NULL AFTER ejc_id,
    ADD COLUMN subfuncao VARCHAR(120) NULL AFTER papel;
