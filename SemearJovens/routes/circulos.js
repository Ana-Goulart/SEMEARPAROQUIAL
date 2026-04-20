const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { getTenantId } = require('../lib/tenantIsolation');

let ensureCirculosPromise = null;

function normalizarNome(nome) {
    return String(nome || '').trim().replace(/\s+/g, ' ');
}

function validarHexCor(valor) {
    if (valor === undefined || valor === null || String(valor).trim() === '') return null;
    const txt = String(valor).trim();
    if (!/^#[0-9A-Fa-f]{6}$/.test(txt)) return null;
    return txt.toUpperCase();
}

async function ensureCirculosTable() {
    if (ensureCirculosPromise) return ensureCirculosPromise;

    ensureCirculosPromise = (async () => {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS circulos (
                id INT AUTO_INCREMENT PRIMARY KEY,
                nome VARCHAR(80) NOT NULL,
                cor_hex VARCHAR(7) NULL,
                ordem INT NOT NULL DEFAULT 0,
                ativo TINYINT(1) NOT NULL DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uk_circulos_nome (nome)
            )
        `);

        try {
            await pool.query('ALTER TABLE circulos DROP INDEX uk_circulos_nome');
        } catch (err) {
            if (!err || (err.code !== 'ER_CANT_DROP_FIELD_OR_KEY' && err.code !== 'ER_BAD_FIELD_ERROR')) {
                throw err;
            }
        }
        try {
            await pool.query('ALTER TABLE circulos ADD UNIQUE KEY uk_circulos_nome_tenant (tenant_id, nome)');
        } catch (err) {
            if (!err || err.code !== 'ER_DUP_KEYNAME') throw err;
        }

        // Sem seed automático: a lista de círculos fica 100% sob gestão do usuário.
    })();

    try {
        await ensureCirculosPromise;
    } finally {
        ensureCirculosPromise = null;
    }
}

router.get('/', async (req, res) => {
    try {
        await ensureCirculosTable();
        const tenantId = getTenantId(req);
        const incluirInativos = String(req.query.todos || '') === '1';
        const sql = incluirInativos
            ? 'SELECT id, nome, cor_hex, ativo, created_at, updated_at FROM circulos WHERE tenant_id = ? ORDER BY nome ASC'
            : 'SELECT id, nome, cor_hex, ativo FROM circulos WHERE ativo = 1 AND tenant_id = ? ORDER BY nome ASC';
        const [rows] = await pool.query(sql, [tenantId]);
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar círculos:', err);
        return res.status(500).json({ error: 'Erro ao listar círculos.' });
    }
});

router.get('/:id/jovens', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID inválido.' });

    try {
        await ensureCirculosTable();
        const tenantId = getTenantId(req);
        const [rowsCirculo] = await pool.query(
            'SELECT nome FROM circulos WHERE id = ? AND tenant_id = ? LIMIT 1',
            [id, tenantId]
        );
        if (!rowsCirculo.length) return res.status(404).json({ error: 'Cor de círculo não encontrada.' });

        const nome = normalizarNome(rowsCirculo[0].nome);
        const [rows] = await pool.query(
            `SELECT id, nome_completo, telefone, sexo, estado_civil, data_nascimento
             FROM jovens
             WHERE tenant_id = ?
               AND TRIM(COALESCE(circulo, '')) = ?
               AND COALESCE(lista_mestre_ativo, 1) = 1
             ORDER BY nome_completo ASC`,
            [tenantId, nome]
        );
        return res.json(rows || []);
    } catch (err) {
        console.error('Erro ao listar jovens do círculo:', err);
        return res.status(500).json({ error: 'Erro ao listar jovens do círculo.' });
    }
});

router.post('/', async (req, res) => {
    try {
        await ensureCirculosTable();
        const tenantId = getTenantId(req);
        const nome = normalizarNome(req.body && req.body.nome);
        if (!nome) return res.status(400).json({ error: 'Nome da cor é obrigatório.' });
        if (nome.length > 80) return res.status(400).json({ error: 'Nome da cor deve ter no máximo 80 caracteres.' });

        const corHex = validarHexCor(req.body && req.body.cor_hex);
        if (!corHex) {
            return res.status(400).json({ error: 'Escolha uma cor para o círculo na paleta.' });
        }

        const ativo = (req.body && (req.body.ativo === false || req.body.ativo === 0 || req.body.ativo === '0')) ? 0 : 1;

        const [result] = await pool.query(
            'INSERT INTO circulos (tenant_id, nome, cor_hex, ativo) VALUES (?, ?, ?, ?)',
            [tenantId, nome, corHex, ativo]
        );
        return res.status(201).json({ id: result.insertId, message: 'Cor de círculo criada com sucesso.' });
    } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Já existe uma cor de círculo com esse nome.' });
        }
        console.error('Erro ao criar círculo:', err);
        return res.status(500).json({ error: 'Erro ao criar cor de círculo.' });
    }
});

router.put('/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID inválido.' });

    try {
        await ensureCirculosTable();
        const tenantId = getTenantId(req);
        const nome = normalizarNome(req.body && req.body.nome);
        if (!nome) return res.status(400).json({ error: 'Nome da cor é obrigatório.' });
        if (nome.length > 80) return res.status(400).json({ error: 'Nome da cor deve ter no máximo 80 caracteres.' });

        const corHex = validarHexCor(req.body && req.body.cor_hex);
        if (!corHex) {
            return res.status(400).json({ error: 'Escolha uma cor para o círculo na paleta.' });
        }

        const ativo = (req.body && (req.body.ativo === false || req.body.ativo === 0 || req.body.ativo === '0')) ? 0 : 1;

        const [result] = await pool.query(
            'UPDATE circulos SET nome = ?, cor_hex = ?, ativo = ? WHERE id = ? AND tenant_id = ?',
            [nome, corHex, ativo, id, tenantId]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Cor de círculo não encontrada.' });
        return res.json({ message: 'Cor de círculo atualizada com sucesso.' });
    } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Já existe uma cor de círculo com esse nome.' });
        }
        console.error('Erro ao atualizar círculo:', err);
        return res.status(500).json({ error: 'Erro ao atualizar cor de círculo.' });
    }
});

router.delete('/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID inválido.' });

    try {
        await ensureCirculosTable();
        const tenantId = getTenantId(req);
        const [rowsCirculo] = await pool.query('SELECT nome FROM circulos WHERE id = ? AND tenant_id = ?', [id, tenantId]);
        if (!rowsCirculo || !rowsCirculo.length) return res.status(404).json({ error: 'Cor de círculo não encontrada.' });

        const nome = normalizarNome(rowsCirculo[0].nome);
        const [rowsUso] = await pool.query(
            "SELECT COUNT(*) AS cnt FROM jovens WHERE TRIM(COALESCE(circulo, '')) = ?",
            [nome]
        );
        const emUso = Number(rowsUso && rowsUso[0] && rowsUso[0].cnt ? rowsUso[0].cnt : 0);
        const forceDelete = String(req.query.force || '') === '1';
        if (emUso > 0) {
            if (!forceDelete) {
                return res.status(409).json({
                    error: `Não é possível excluir "${nome}" porque existem ${emUso} jovem(ns) usando essa cor.`,
                    emUso,
                    canForce: true
                });
            }
            await pool.query(
                "UPDATE jovens SET circulo = NULL WHERE TRIM(COALESCE(circulo, '')) = ?",
                [nome]
            );
        }

        try {
            const [result] = await pool.query('DELETE FROM circulos WHERE id = ? AND tenant_id = ?', [id, tenantId]);
            if (!result.affectedRows) return res.status(404).json({ error: 'Cor de círculo não encontrada.' });
            return res.json({
                message: emUso > 0
                    ? `Cor de círculo removida com sucesso. ${emUso} jovem(ns) tiveram o campo círculo limpo.`
                    : 'Cor de círculo removida com sucesso.'
            });
        } catch (errDelete) {
            // Fallback: se não conseguir remover fisicamente por algum motivo, desativa a cor.
            await pool.query('UPDATE circulos SET ativo = 0 WHERE id = ? AND tenant_id = ?', [id, tenantId]);
            return res.json({
                message: emUso > 0
                    ? `Cor desativada com sucesso. ${emUso} jovem(ns) tiveram o campo círculo limpo.`
                    : 'Cor desativada com sucesso.'
            });
        }
    } catch (err) {
        console.error('Erro ao remover círculo:', err);
        return res.status(500).json({ error: err && err.message ? err.message : 'Erro ao remover cor de círculo.' });
    }
});

module.exports = router;
