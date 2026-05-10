-- Migration: Criar tabela teste_ana
CREATE TABLE teste_ana (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);