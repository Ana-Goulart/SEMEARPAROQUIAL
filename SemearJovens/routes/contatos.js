const express = require('express');
const { pool } = require('../database');
const { getTenantId } = require('../lib/tenantIsolation');
const { ensurePastoraisTables, ensureContatosPastoralColumn } = require('../lib/pastorais');

const router = express.Router();

let ensured = false;
let ensurePromise = null;

async function ensureTable() {
    if (ensured) return;
    if (ensurePromise) return ensurePromise;
    ensurePromise = (async () => {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS contatos_telefonicos (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tenant_id INT NOT NULL,
                nome VARCHAR(180) NOT NULL,
                telefone VARCHAR(30) NOT NULL,
                descricao VARCHAR(255) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        await ensureContatosPastoralColumn();
        await ensurePastoraisTables();
        ensured = true;
    })();
    try {
        await ensurePromise;
    } finally {
        ensurePromise = null;
    }
}

router.get('/', async (req, res) => {
    try {
        await ensureTable();
        const tenantId = getTenantId(req);
        const [rows] = await pool.query(
            `SELECT c.id, c.nome, c.telefone, c.descricao, c.pastoral_id,
                    p.nome AS pastoral_nome,
                    c.created_at, c.updated_at
             FROM contatos_telefonicos c
             LEFT JOIN pastorais p ON p.id = c.pastoral_id AND p.tenant_id = c.tenant_id
             WHERE c.tenant_id = ?
             ORDER BY c.nome ASC`,
            [tenantId]
        );
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar contatos:', err);
        return res.status(500).json({ error: 'Erro ao listar contatos.' });
    }
});

router.post('/', async (req, res) => {
    try {
        await ensureTable();
        const tenantId = getTenantId(req);
        const nome = String(req.body.nome || '').trim();
        const telefone = String(req.body.telefone || '').trim();
        const descricao = String(req.body.descricao || '').trim() || null;
        const pastoralIdRaw = req.body.pastoral_id;
        const pastoralId = (pastoralIdRaw === null || pastoralIdRaw === '' || pastoralIdRaw === undefined)
            ? null
            : Number(pastoralIdRaw);
        if (!nome || !telefone) {
            return res.status(400).json({ error: 'Nome e telefone são obrigatórios.' });
        }
        if (pastoralIdRaw === undefined) {
            return res.status(400).json({ error: 'Pastoral é obrigatória.' });
        }
        if (pastoralId !== null && !Number.isFinite(pastoralId)) {
            return res.status(400).json({ error: 'Pastoral inválida.' });
        }
        if (pastoralId !== null) {
            const [[pastoral]] = await pool.query(
                'SELECT id FROM pastorais WHERE id = ? AND tenant_id = ? LIMIT 1',
                [pastoralId, tenantId]
            );
            if (!pastoral) return res.status(400).json({ error: 'Pastoral não encontrada.' });
        }
        const [result] = await pool.query(
            `INSERT INTO contatos_telefonicos (tenant_id, nome, telefone, descricao, pastoral_id)
             VALUES (?, ?, ?, ?, ?)`,
            [tenantId, nome, telefone, descricao, pastoralId]
        );
        return res.status(201).json({ id: result.insertId, message: 'Contato cadastrado com sucesso.' });
    } catch (err) {
        console.error('Erro ao criar contato:', err);
        return res.status(500).json({ error: 'Erro ao criar contato.' });
    }
});

router.put('/:id', async (req, res) => {
    try {
        await ensureTable();
        const tenantId = getTenantId(req);
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ error: 'ID inválido.' });
        const nome = String(req.body.nome || '').trim();
        const telefone = String(req.body.telefone || '').trim();
        const descricao = String(req.body.descricao || '').trim() || null;
        const pastoralIdRaw = req.body.pastoral_id;
        const pastoralId = (pastoralIdRaw === null || pastoralIdRaw === '' || pastoralIdRaw === undefined)
            ? null
            : Number(pastoralIdRaw);
        if (!nome || !telefone) {
            return res.status(400).json({ error: 'Nome e telefone são obrigatórios.' });
        }
        if (pastoralIdRaw === undefined) {
            return res.status(400).json({ error: 'Pastoral é obrigatória.' });
        }
        if (pastoralId !== null && !Number.isFinite(pastoralId)) {
            return res.status(400).json({ error: 'Pastoral inválida.' });
        }
        if (pastoralId !== null) {
            const [[pastoral]] = await pool.query(
                'SELECT id FROM pastorais WHERE id = ? AND tenant_id = ? LIMIT 1',
                [pastoralId, tenantId]
            );
            if (!pastoral) return res.status(400).json({ error: 'Pastoral não encontrada.' });
        }
        const [result] = await pool.query(
            `UPDATE contatos_telefonicos
             SET nome = ?, telefone = ?, descricao = ?, pastoral_id = ?
             WHERE id = ? AND tenant_id = ?`,
            [nome, telefone, descricao, pastoralId, id, tenantId]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Contato não encontrado.' });
        return res.json({ message: 'Contato atualizado com sucesso.' });
    } catch (err) {
        console.error('Erro ao atualizar contato:', err);
        return res.status(500).json({ error: 'Erro ao atualizar contato.' });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        await ensureTable();
        const tenantId = getTenantId(req);
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ error: 'ID inválido.' });
        const [result] = await pool.query(
            'DELETE FROM contatos_telefonicos WHERE id = ? AND tenant_id = ?',
            [id, tenantId]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Contato não encontrado.' });
        return res.json({ message: 'Contato removido com sucesso.' });
    } catch (err) {
        console.error('Erro ao remover contato:', err);
        return res.status(500).json({ error: 'Erro ao remover contato.' });
    }
});

module.exports = router;
