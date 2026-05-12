-- Permite cadastrar/importar jovens e tios sem telefone informado.
ALTER TABLE jovens MODIFY COLUMN telefone TEXT NULL;
ALTER TABLE tios_casais MODIFY COLUMN telefone_tio TEXT NULL;
ALTER TABLE tios_casais MODIFY COLUMN telefone_tia TEXT NULL;
