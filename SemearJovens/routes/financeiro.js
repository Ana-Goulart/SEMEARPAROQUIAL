const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { getTenantId, ensureTenantIsolation } = require('../lib/tenantIsolation');

let tabelaFinanceiroGarantida = false;

async function garantirTabelaFinanceiro() {
    if (tabelaFinanceiroGarantida) return;
    await ensureTenantIsolation();
    await pool.query(`
        CREATE TABLE IF NOT EXISTS financeiro_movimentacoes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            tipo ENUM('ENTRADA', 'SAIDA') NOT NULL,
            valor DECIMAL(12,2) NOT NULL,
            descricao VARCHAR(255) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_financeiro_movimentacoes_tenant (tenant_id)
        )
    `);
    tabelaFinanceiroGarantida = true;
}

async function buscarSaldoAtual(tenantId, connection = pool) {
    const [rows] = await connection.query(`
        SELECT
            COALESCE(SUM(
                CASE
                    WHEN tipo = 'ENTRADA' THEN valor
                    ELSE -valor
                END
            ), 0) AS saldo_atual
        FROM financeiro_movimentacoes
        WHERE tenant_id = ?
    `, [tenantId]);
    return Number(rows && rows[0] ? rows[0].saldo_atual : 0);
}

router.get('/resumo', async (req, res) => {
    const tenantId = getTenantId(req);
    try {
        await garantirTabelaFinanceiro();
        const saldo = await buscarSaldoAtual(tenantId);
        res.json({ saldo_atual: saldo });
    } catch (err) {
        console.error('Erro ao buscar resumo financeiro:', err);
        res.status(500).json({ error: 'Erro ao buscar resumo financeiro' });
    }
});

router.get('/movimentacoes', async (req, res) => {
    const tenantId = getTenantId(req);
    try {
        await garantirTabelaFinanceiro();
        const [rows] = await pool.query(`
            SELECT id, tipo, valor, descricao, created_at
            FROM financeiro_movimentacoes
            WHERE tenant_id = ?
            ORDER BY created_at DESC, id DESC
        `, [tenantId]);
        res.json(rows);
    } catch (err) {
        console.error('Erro ao buscar movimentações financeiras:', err);
        res.status(500).json({ error: 'Erro ao buscar movimentações financeiras' });
    }
});

router.post('/movimentacoes', async (req, res) => {
    const tenantId = getTenantId(req);
    const tipo = String(req.body.tipo || '').trim().toUpperCase();
    const descricao = String(req.body.descricao || '').trim();
    const valor = Number(req.body.valor);

    if (!['ENTRADA', 'SAIDA'].includes(tipo)) {
        return res.status(400).json({ error: "Tipo inválido. Use 'ENTRADA' ou 'SAIDA'." });
    }
    if (!descricao) {
        return res.status(400).json({ error: 'Descrição é obrigatória.' });
    }
    if (!Number.isFinite(valor) || valor <= 0) {
        return res.status(400).json({ error: 'Valor inválido.' });
    }

    const connection = await pool.getConnection();
    try {
        await garantirTabelaFinanceiro();
        await connection.beginTransaction();

        const saldoAtual = await buscarSaldoAtual(tenantId, connection);
        if (tipo === 'SAIDA' && valor > saldoAtual) {
            await connection.rollback();
            return res.status(400).json({ error: 'Saldo insuficiente para registrar esta saída.' });
        }

        const valorNormalizado = Number(valor.toFixed(2));
        const [result] = await connection.query(
            'INSERT INTO financeiro_movimentacoes (tenant_id, tipo, valor, descricao) VALUES (?, ?, ?, ?)',
            [tenantId, tipo, valorNormalizado, descricao]
        );

        await connection.commit();
        const novoSaldo = await buscarSaldoAtual(tenantId);
        res.status(201).json({
            id: result.insertId,
            message: 'Movimentação registrada com sucesso.',
            saldo_atual: novoSaldo
        });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao registrar movimentação financeira:', err);
        res.status(500).json({ error: 'Erro ao registrar movimentação financeira' });
    } finally {
        connection.release();
    }
});

router.post('/zerar', async (req, res) => {
    const tenantId = getTenantId(req);
    try {
        await garantirTabelaFinanceiro();
        await pool.query('DELETE FROM financeiro_movimentacoes WHERE tenant_id = ?', [tenantId]);
        res.json({ message: 'Saldo zerado com sucesso.', saldo_atual: 0 });
    } catch (err) {
        console.error('Erro ao zerar saldo financeiro:', err);
        res.status(500).json({ error: 'Erro ao zerar saldo financeiro' });
    }
});

module.exports = router;
