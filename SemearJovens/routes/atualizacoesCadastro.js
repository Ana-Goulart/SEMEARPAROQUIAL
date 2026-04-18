const express = require('express');
const { pool } = require('../database');
const { getTenantId } = require('../lib/tenantIsolation');

const router = express.Router();

async function ensureAtualizacaoTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS jovens_atualizacao_comentarios (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NULL,
            jovem_id INT NULL,
            nome_completo VARCHAR(180) NULL,
            telefone VARCHAR(30) NULL,
            comentario TEXT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS jovens_atualizacao_nao_encontrado (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NULL,
            nome_completo VARCHAR(180) NOT NULL,
            telefone VARCHAR(30) NOT NULL,
            ejc_que_fez VARCHAR(180) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    const [hasObsRows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'jovens_atualizacao_nao_encontrado'
          AND COLUMN_NAME = 'observacoes_adicionais'
    `);
    if (!hasObsRows[0]?.cnt) {
        await pool.query('ALTER TABLE jovens_atualizacao_nao_encontrado ADD COLUMN observacoes_adicionais TEXT NULL AFTER ejc_que_fez');
    }
    const [hasOrigemRows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'jovens_atualizacao_nao_encontrado'
          AND COLUMN_NAME = 'origem_formulario'
    `);
    if (!hasOrigemRows[0]?.cnt) {
        await pool.query('ALTER TABLE jovens_atualizacao_nao_encontrado ADD COLUMN origem_formulario VARCHAR(120) NULL AFTER observacoes_adicionais');
    }
}

router.get('/comentarios', async (req, res) => {
    try {
        await ensureAtualizacaoTables();
        const tenantId = getTenantId(req);
        const [rows] = await pool.query(
            `SELECT id, nome_completo, telefone, comentario, created_at
             FROM jovens_atualizacao_comentarios
             WHERE tenant_id = ?
             ORDER BY created_at DESC`,
            [tenantId]
        );
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar comentários:', err);
        return res.status(500).json({ error: 'Erro ao listar comentários.' });
    }
});

router.get('/nao-encontrados', async (req, res) => {
    try {
        await ensureAtualizacaoTables();
        const tenantId = getTenantId(req);
        const [rows] = await pool.query(
            `SELECT id, nome_completo, telefone, ejc_que_fez, observacoes_adicionais, origem_formulario, created_at
             FROM jovens_atualizacao_nao_encontrado
             WHERE tenant_id = ?
             ORDER BY created_at DESC`,
            [tenantId]
        );
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar não encontrados:', err);
        return res.status(500).json({ error: 'Erro ao listar não encontrados.' });
    }
});

module.exports = router;
