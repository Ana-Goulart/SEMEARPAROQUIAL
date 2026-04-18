const express = require('express');
const { pool } = require('../database');
const { getTenantId } = require('../lib/tenantIsolation');
const { ensurePastoraisTables, ensureContatosPastoralColumn } = require('../lib/pastorais');

const router = express.Router();

async function ensureTudo() {
    await ensurePastoraisTables();
    await ensureContatosPastoralColumn();
}

router.get('/', async (req, res) => {
    try {
        await ensureTudo();
        const tenantId = getTenantId(req);
        const [rows] = await pool.query(
            `SELECT id, nome, descricao, created_at, updated_at
             FROM pastorais
             WHERE tenant_id = ?
             ORDER BY nome ASC`,
            [tenantId]
        );
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar pastorais:', err);
        return res.status(500).json({ error: 'Erro ao listar pastorais.' });
    }
});

router.post('/', async (req, res) => {
    try {
        await ensureTudo();
        const tenantId = getTenantId(req);
        const nome = String(req.body.nome || '').trim();
        const descricao = String(req.body.descricao || '').trim() || null;
        if (!nome) return res.status(400).json({ error: 'Nome é obrigatório.' });

        const [result] = await pool.query(
            `INSERT INTO pastorais (tenant_id, nome, descricao)
             VALUES (?, ?, ?)`,
            [tenantId, nome, descricao]
        );
        return res.status(201).json({ id: result.insertId, message: 'Pastoral cadastrada com sucesso.' });
    } catch (err) {
        console.error('Erro ao criar pastoral:', err);
        return res.status(500).json({ error: 'Erro ao criar pastoral.' });
    }
});

router.put('/:id', async (req, res) => {
    try {
        await ensureTudo();
        const tenantId = getTenantId(req);
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ error: 'ID inválido.' });
        const nome = String(req.body.nome || '').trim();
        const descricao = String(req.body.descricao || '').trim() || null;
        if (!nome) return res.status(400).json({ error: 'Nome é obrigatório.' });

        const [result] = await pool.query(
            `UPDATE pastorais
             SET nome = ?, descricao = ?
             WHERE id = ? AND tenant_id = ?`,
            [nome, descricao, id, tenantId]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Pastoral não encontrada.' });
        return res.json({ message: 'Pastoral atualizada com sucesso.' });
    } catch (err) {
        console.error('Erro ao atualizar pastoral:', err);
        return res.status(500).json({ error: 'Erro ao atualizar pastoral.' });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        await ensureTudo();
        const tenantId = getTenantId(req);
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ error: 'ID inválido.' });

        const [[contato]] = await pool.query(
            'SELECT id FROM contatos_telefonicos WHERE tenant_id = ? AND pastoral_id = ? LIMIT 1',
            [tenantId, id]
        );
        if (contato) {
            return res.status(400).json({ error: 'Não é possível excluir. Existem contatos vinculados a esta pastoral.' });
        }

        const [[jovem]] = await pool.query(
            'SELECT id FROM pastorais_jovens WHERE tenant_id = ? AND pastoral_id = ? LIMIT 1',
            [tenantId, id]
        );
        if (jovem) {
            return res.status(400).json({ error: 'Não é possível excluir. Existem jovens vinculados a esta pastoral.' });
        }

        const [result] = await pool.query(
            'DELETE FROM pastorais WHERE id = ? AND tenant_id = ?',
            [id, tenantId]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Pastoral não encontrada.' });
        return res.json({ message: 'Pastoral removida com sucesso.' });
    } catch (err) {
        console.error('Erro ao remover pastoral:', err);
        return res.status(500).json({ error: 'Erro ao remover pastoral.' });
    }
});

router.get('/:id/jovens', async (req, res) => {
    try {
        await ensureTudo();
        const tenantId = getTenantId(req);
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ error: 'ID inválido.' });

        const [rows] = await pool.query(
            `SELECT j.id, j.nome_completo, j.telefone
             FROM pastorais_jovens pj
             JOIN jovens j ON j.id = pj.jovem_id AND j.tenant_id = pj.tenant_id
             WHERE pj.tenant_id = ? AND pj.pastoral_id = ?
             ORDER BY j.nome_completo ASC`,
            [tenantId, id]
        );
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar jovens da pastoral:', err);
        return res.status(500).json({ error: 'Erro ao listar jovens da pastoral.' });
    }
});

router.post('/:id/jovens', async (req, res) => {
    try {
        await ensureTudo();
        const tenantId = getTenantId(req);
        const id = Number(req.params.id);
        const jovemId = Number(req.body.jovem_id);
        if (!id || !jovemId) return res.status(400).json({ error: 'Dados inválidos.' });

        const [[pastoral]] = await pool.query(
            'SELECT id FROM pastorais WHERE id = ? AND tenant_id = ? LIMIT 1',
            [id, tenantId]
        );
        if (!pastoral) return res.status(404).json({ error: 'Pastoral não encontrada.' });

        const [[jovem]] = await pool.query(
            'SELECT id FROM jovens WHERE id = ? AND tenant_id = ? LIMIT 1',
            [jovemId, tenantId]
        );
        if (!jovem) return res.status(404).json({ error: 'Jovem não encontrado.' });

        await pool.query(
            `INSERT INTO pastorais_jovens (tenant_id, pastoral_id, jovem_id)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE pastoral_id = pastoral_id`,
            [tenantId, id, jovemId]
        );

        return res.status(201).json({ message: 'Jovem vinculado com sucesso.' });
    } catch (err) {
        console.error('Erro ao vincular jovem:', err);
        return res.status(500).json({ error: 'Erro ao vincular jovem.' });
    }
});

router.delete('/:id/jovens/:jovemId', async (req, res) => {
    try {
        await ensureTudo();
        const tenantId = getTenantId(req);
        const id = Number(req.params.id);
        const jovemId = Number(req.params.jovemId);
        if (!id || !jovemId) return res.status(400).json({ error: 'Dados inválidos.' });

        const [result] = await pool.query(
            'DELETE FROM pastorais_jovens WHERE tenant_id = ? AND pastoral_id = ? AND jovem_id = ?',
            [tenantId, id, jovemId]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Vínculo não encontrado.' });
        return res.json({ message: 'Vínculo removido com sucesso.' });
    } catch (err) {
        console.error('Erro ao remover vínculo:', err);
        return res.status(500).json({ error: 'Erro ao remover vínculo.' });
    }
});

module.exports = router;
