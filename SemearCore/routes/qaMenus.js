const express = require('express');
const { pool } = require('../database');
const { ensureTenantStructure } = require('../lib/tenantSetup');

const router = express.Router();

function requireAdmin(req, res, next) {
    if (!req.admin || !req.admin.id) return res.status(401).json({ error: 'Não autenticado.' });
    return next();
}

router.get('/', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const [rows] = await pool.query(
            'SELECT id, nome, submenu_de, ativo, ordem, created_at FROM qa_menus ORDER BY ordem ASC, nome ASC'
        );
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar qa_menus:', err);
        return res.status(500).json({ error: 'Erro ao carregar menus.' });
    }
});

router.post('/', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const nome = String(req.body.nome || '').trim();
        if (!nome) return res.status(400).json({ error: 'Nome é obrigatório.' });
        const submenu_de = req.body.submenu_de ? Number(req.body.submenu_de) : null;
        const ordem = Number(req.body.ordem) || 0;
        const ativo = req.body.ativo !== false ? 1 : 0;
        const [result] = await pool.query(
            'INSERT INTO qa_menus (nome, submenu_de, ordem, ativo) VALUES (?, ?, ?, ?)',
            [nome, submenu_de, ordem, ativo]
        );
        return res.json({ id: result.insertId, message: 'Menu criado com sucesso.' });
    } catch (err) {
        console.error('Erro ao criar qa_menu:', err);
        return res.status(500).json({ error: 'Erro ao criar menu.' });
    }
});

router.put('/:id', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const nome = String(req.body.nome || '').trim();
        if (!nome) return res.status(400).json({ error: 'Nome é obrigatório.' });
        const submenu_de = req.body.submenu_de ? Number(req.body.submenu_de) : null;
        const ordem = Number(req.body.ordem) || 0;
        const ativo = req.body.ativo !== false ? 1 : 0;
        const [result] = await pool.query(
            'UPDATE qa_menus SET nome = ?, submenu_de = ?, ordem = ?, ativo = ? WHERE id = ?',
            [nome, submenu_de, ordem, ativo, Number(req.params.id)]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Menu não encontrado.' });
        return res.json({ message: 'Menu atualizado com sucesso.' });
    } catch (err) {
        console.error('Erro ao atualizar qa_menu:', err);
        return res.status(500).json({ error: 'Erro ao atualizar menu.' });
    }
});

router.patch('/:id/ativo', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const ativo = req.body.ativo ? 1 : 0;
        const [result] = await pool.query(
            'UPDATE qa_menus SET ativo = ? WHERE id = ?',
            [ativo, Number(req.params.id)]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Menu não encontrado.' });
        return res.json({ message: 'Menu atualizado com sucesso.' });
    } catch (err) {
        console.error('Erro ao toggle qa_menu:', err);
        return res.status(500).json({ error: 'Erro ao atualizar menu.' });
    }
});

router.delete('/:id', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const menuId = Number(req.params.id);
        const [[menu]] = await pool.query('SELECT id, nome FROM qa_menus WHERE id = ?', [menuId]);
        if (!menu) return res.status(404).json({ error: 'Menu não encontrado.' });
        await pool.query('DELETE FROM qa_menu_funcionalidades WHERE menu_id = ?', [menuId]);
        await pool.query('DELETE FROM qa_menus WHERE id = ?', [menuId]);
        return res.json({ message: `Menu "${menu.nome}" excluído com sucesso.` });
    } catch (err) {
        console.error('Erro ao excluir qa_menu:', err);
        return res.status(500).json({ error: 'Erro ao excluir menu.' });
    }
});

// --- Funcionalidades de menu ---

router.get('/:id/funcionalidades', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const [rows] = await pool.query(
            'SELECT id, menu_id, descricao, ativo, ordem, created_at FROM qa_menu_funcionalidades WHERE menu_id = ? ORDER BY ordem ASC, id ASC',
            [Number(req.params.id)]
        );
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar funcionalidades:', err);
        return res.status(500).json({ error: 'Erro ao carregar funcionalidades.' });
    }
});

router.post('/:id/funcionalidades', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const menuId = Number(req.params.id);
        const descricao = String(req.body.descricao || '').trim();
        if (!descricao) return res.status(400).json({ error: 'Descrição é obrigatória.' });
        const [[menu]] = await pool.query('SELECT id FROM qa_menus WHERE id = ?', [menuId]);
        if (!menu) return res.status(404).json({ error: 'Menu não encontrado.' });
        const ordem = Number(req.body.ordem) || 0;
        const [result] = await pool.query(
            'INSERT INTO qa_menu_funcionalidades (menu_id, descricao, ordem) VALUES (?, ?, ?)',
            [menuId, descricao, ordem]
        );
        return res.json({ id: result.insertId, message: 'Funcionalidade criada com sucesso.' });
    } catch (err) {
        console.error('Erro ao criar funcionalidade:', err);
        return res.status(500).json({ error: 'Erro ao criar funcionalidade.' });
    }
});

router.put('/:id/funcionalidades/:funcionalidadeId', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const descricao = String(req.body.descricao || '').trim();
        if (!descricao) return res.status(400).json({ error: 'Descrição é obrigatória.' });
        const ordem = Number(req.body.ordem) || 0;
        const ativo = req.body.ativo !== false ? 1 : 0;
        const [result] = await pool.query(
            'UPDATE qa_menu_funcionalidades SET descricao = ?, ordem = ?, ativo = ? WHERE id = ? AND menu_id = ?',
            [descricao, ordem, ativo, Number(req.params.funcionalidadeId), Number(req.params.id)]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Funcionalidade não encontrada.' });
        return res.json({ message: 'Funcionalidade atualizada com sucesso.' });
    } catch (err) {
        console.error('Erro ao atualizar funcionalidade:', err);
        return res.status(500).json({ error: 'Erro ao atualizar funcionalidade.' });
    }
});

router.patch('/:id/funcionalidades/:funcionalidadeId/ativo', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const ativo = req.body.ativo ? 1 : 0;
        const [result] = await pool.query(
            'UPDATE qa_menu_funcionalidades SET ativo = ? WHERE id = ? AND menu_id = ?',
            [ativo, Number(req.params.funcionalidadeId), Number(req.params.id)]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Funcionalidade não encontrada.' });
        return res.json({ message: 'Funcionalidade atualizada com sucesso.' });
    } catch (err) {
        console.error('Erro ao toggle funcionalidade:', err);
        return res.status(500).json({ error: 'Erro ao atualizar funcionalidade.' });
    }
});

module.exports = router;
