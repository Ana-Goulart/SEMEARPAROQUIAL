const express = require('express');
const { pool } = require('../database');
const { ensureTenantStructure } = require('../lib/tenantSetup');

const router = express.Router();

function requireAdmin(req, res, next) {
    if (!req.admin || !req.admin.id) return res.status(401).json({ error: 'Não autenticado.' });
    return next();
}

// GET /movimentacoes
router.get('/movimentacoes', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const dataInicio = req.query.data_inicio ? String(req.query.data_inicio) : null;
        const dataFim = req.query.data_fim ? String(req.query.data_fim) : null;

        let sql = 'SELECT * FROM financeiro_movimentacoes WHERE 1=1';
        const params = [];
        if (dataInicio) { sql += ' AND data >= ?'; params.push(dataInicio); }
        if (dataFim) { sql += ' AND data <= ?'; params.push(dataFim); }
        sql += ' ORDER BY `data` DESC, id DESC';

        const [rows] = await pool.query(sql, params);
        const normalized = rows.map(r => ({ ...r, tipo: String(r.tipo || '').toLowerCase() }));

        const [[saldo]] = await pool.query(
            `SELECT
                COALESCE(SUM(CASE WHEN LOWER(tipo)='entrada' THEN valor ELSE -valor END), 0) AS saldo,
                COALESCE(SUM(CASE WHEN LOWER(tipo)='entrada' THEN valor ELSE 0 END), 0) AS total_entradas,
                COALESCE(SUM(CASE WHEN LOWER(tipo)='saida' THEN valor ELSE 0 END), 0) AS total_saidas
             FROM financeiro_movimentacoes`
        );

        return res.json({
            movimentacoes: normalized,
            saldo: saldo.saldo,
            total_entradas: saldo.total_entradas,
            total_saidas: saldo.total_saidas
        });
    } catch (err) {
        console.error('Erro ao listar movimentações:', err);
        return res.status(500).json({ error: 'Erro ao carregar movimentações.' });
    }
});

// GET /movimentacoes/exportar  (CSV com BOM para Excel)
router.get('/movimentacoes/exportar', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const dataInicio = req.query.data_inicio ? String(req.query.data_inicio) : null;
        const dataFim = req.query.data_fim ? String(req.query.data_fim) : null;

        let sql = 'SELECT data, tipo, valor, descricao FROM financeiro_movimentacoes WHERE 1=1';
        const params = [];
        if (dataInicio) { sql += ' AND data >= ?'; params.push(dataInicio); }
        if (dataFim) { sql += ' AND data <= ?'; params.push(dataFim); }
        sql += ' ORDER BY `data` ASC, id ASC';

        const [rows] = await pool.query(sql, params);

        const linhas = [
            'Data,Tipo,Valor,Descricao',
            ...rows.map(r => {
                const d = r.data ? new Date(r.data).toLocaleDateString('pt-BR') : '';
                const tipo = String(r.tipo || '').toLowerCase() === 'entrada' ? 'Entrada' : 'Saída';
                const valor = Number(r.valor).toFixed(2).replace('.', ',');
                const desc = String(r.descricao || '').replace(/"/g, '""');
                return `${d},${tipo},${valor},"${desc}"`;
            })
        ];

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="fluxo-caixa.csv"');
        return res.send('﻿' + linhas.join('\n'));
    } catch (err) {
        console.error('Erro ao exportar movimentações:', err);
        return res.status(500).json({ error: 'Erro ao exportar.' });
    }
});

// POST /movimentacoes
router.post('/movimentacoes', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const tipo = String(req.body.tipo || '').trim();
        const descricao = String(req.body.descricao || '').trim();
        const valor = parseFloat(req.body.valor);
        const data = String(req.body.data || '').trim();

        if (!['entrada', 'saida'].includes(tipo.toLowerCase())) return res.status(400).json({ error: 'Tipo inválido.' });
        if (!descricao) return res.status(400).json({ error: 'Descrição obrigatória.' });
        if (!valor || valor <= 0 || isNaN(valor)) return res.status(400).json({ error: 'Valor inválido.' });
        if (!data) return res.status(400).json({ error: 'Data obrigatória.' });

        const [result] = await pool.query(
            'INSERT INTO financeiro_movimentacoes (tipo, descricao, valor, data) VALUES (?, ?, ?, ?)',
            [tipo, descricao, valor, data]
        );
        return res.status(201).json({ id: result.insertId, message: 'Movimentação registrada.' });
    } catch (err) {
        console.error('Erro ao criar movimentação:', err);
        return res.status(500).json({ error: 'Erro ao registrar movimentação.' });
    }
});

// PUT /movimentacoes/:id
router.put('/movimentacoes/:id', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ error: 'ID inválido.' });

        const tipo = String(req.body.tipo || '').trim();
        const descricao = String(req.body.descricao || '').trim();
        const valor = parseFloat(req.body.valor);
        const data = String(req.body.data || '').trim();

        if (!['entrada', 'saida'].includes(tipo.toLowerCase())) return res.status(400).json({ error: 'Tipo inválido.' });
        if (!descricao) return res.status(400).json({ error: 'Descrição obrigatória.' });
        if (!valor || valor <= 0 || isNaN(valor)) return res.status(400).json({ error: 'Valor inválido.' });
        if (!data) return res.status(400).json({ error: 'Data obrigatória.' });

        const [result] = await pool.query(
            'UPDATE financeiro_movimentacoes SET tipo=?, descricao=?, valor=?, data=? WHERE id=?',
            [tipo, descricao, valor, data, id]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Movimentação não encontrada.' });
        return res.json({ message: 'Movimentação atualizada.' });
    } catch (err) {
        console.error('Erro ao editar movimentação:', err);
        return res.status(500).json({ error: 'Erro ao editar.' });
    }
});

// DELETE /movimentacoes/:id
router.delete('/movimentacoes/:id', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ error: 'ID inválido.' });

        const [result] = await pool.query('DELETE FROM financeiro_movimentacoes WHERE id=?', [id]);
        if (!result.affectedRows) return res.status(404).json({ error: 'Movimentação não encontrada.' });
        return res.json({ message: 'Movimentação excluída.' });
    } catch (err) {
        console.error('Erro ao excluir movimentação:', err);
        return res.status(500).json({ error: 'Erro ao excluir.' });
    }
});

// GET /dashboard  —  saldo + alertas ativos para o painel principal
router.get('/dashboard', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();

        const [[saldo]] = await pool.query(
            `SELECT COALESCE(SUM(CASE WHEN LOWER(tipo)='entrada' THEN valor ELSE -valor END), 0) AS saldo
             FROM financeiro_movimentacoes`
        );

        const [alertas] = await pool.query(`
            SELECT *,
                   DATEDIFF(data_vencimento, CURDATE()) AS dias_para_vencer
            FROM financeiro_alertas
            WHERE status = 'pendente'
              AND DATEDIFF(data_vencimento, CURDATE()) <= dias_antecedencia
            ORDER BY data_vencimento ASC
        `);

        return res.json({ saldo: saldo.saldo, alertas });
    } catch (err) {
        console.error('Erro ao carregar dashboard financeiro:', err);
        return res.status(500).json({ error: 'Erro ao carregar dashboard financeiro.' });
    }
});

// GET /alertas
router.get('/alertas', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const [rows] = await pool.query(
            'SELECT * FROM financeiro_alertas ORDER BY data_vencimento ASC, id ASC'
        );
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar alertas:', err);
        return res.status(500).json({ error: 'Erro ao carregar alertas.' });
    }
});

// POST /alertas
router.post('/alertas', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const descricao = String(req.body.descricao || '').trim();
        const valor = req.body.valor !== '' && req.body.valor != null ? parseFloat(req.body.valor) : null;
        const dataVencimento = String(req.body.data_vencimento || '').trim();
        const diasAntecedencia = Number(req.body.dias_antecedencia || 3);
        const status = String(req.body.status || 'pendente').trim();

        if (!descricao) return res.status(400).json({ error: 'Descrição obrigatória.' });
        if (!dataVencimento) return res.status(400).json({ error: 'Data de vencimento obrigatória.' });
        if (!['pendente', 'pago', 'recebido'].includes(status)) return res.status(400).json({ error: 'Status inválido.' });

        const [result] = await pool.query(
            'INSERT INTO financeiro_alertas (descricao, valor, data_vencimento, dias_antecedencia, status) VALUES (?, ?, ?, ?, ?)',
            [descricao, valor, dataVencimento, diasAntecedencia, status]
        );
        return res.status(201).json({ id: result.insertId, message: 'Lembrete cadastrado.' });
    } catch (err) {
        console.error('Erro ao criar alerta:', err);
        return res.status(500).json({ error: 'Erro ao cadastrar lembrete.' });
    }
});

// PUT /alertas/:id
router.put('/alertas/:id', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ error: 'ID inválido.' });

        const descricao = String(req.body.descricao || '').trim();
        const valor = req.body.valor !== '' && req.body.valor != null ? parseFloat(req.body.valor) : null;
        const dataVencimento = String(req.body.data_vencimento || '').trim();
        const diasAntecedencia = Number(req.body.dias_antecedencia || 3);
        const status = String(req.body.status || 'pendente').trim();

        if (!descricao) return res.status(400).json({ error: 'Descrição obrigatória.' });
        if (!dataVencimento) return res.status(400).json({ error: 'Data de vencimento obrigatória.' });
        if (!['pendente', 'pago', 'recebido'].includes(status)) return res.status(400).json({ error: 'Status inválido.' });

        const [result] = await pool.query(
            'UPDATE financeiro_alertas SET descricao=?, valor=?, data_vencimento=?, dias_antecedencia=?, status=? WHERE id=?',
            [descricao, valor, dataVencimento, diasAntecedencia, status, id]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Lembrete não encontrado.' });
        return res.json({ message: 'Lembrete atualizado.' });
    } catch (err) {
        console.error('Erro ao editar alerta:', err);
        return res.status(500).json({ error: 'Erro ao editar.' });
    }
});

// DELETE /alertas/:id
router.delete('/alertas/:id', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ error: 'ID inválido.' });

        const [result] = await pool.query('DELETE FROM financeiro_alertas WHERE id=?', [id]);
        if (!result.affectedRows) return res.status(404).json({ error: 'Lembrete não encontrado.' });
        return res.json({ message: 'Lembrete excluído.' });
    } catch (err) {
        console.error('Erro ao excluir alerta:', err);
        return res.status(500).json({ error: 'Erro ao excluir.' });
    }
});

module.exports = router;
