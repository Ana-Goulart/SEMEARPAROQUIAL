-- Guarda nos tios apenas o tipo de encontro realizado: ECC ou ECNA.
ALTER TABLE tios_casais ADD COLUMN encontro_tipo ENUM('ECC','ECNA') NULL AFTER ecc_id;

UPDATE tios_casais c
LEFT JOIN tios_ecc e
  ON e.id = c.ecc_id
 AND e.tenant_id = c.tenant_id
SET c.encontro_tipo = COALESCE(c.encontro_tipo, e.tipo)
WHERE c.encontro_tipo IS NULL
  AND e.tipo IN ('ECC', 'ECNA');
