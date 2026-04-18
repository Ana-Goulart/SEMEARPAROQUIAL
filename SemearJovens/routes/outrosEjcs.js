const express = require('express');
const router = express.Router();
const db = require('../database');
const { getTenantId } = require('../lib/tenantIsolation');

async function hasTable(tableName) {
    const [rows] = await db.pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
    `, [tableName]);
    return !!(rows && rows[0] && rows[0].cnt > 0);
}

async function hasColumn(tableName, columnName) {
    const [rows] = await db.pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
    `, [tableName, columnName]);
    return !!(rows && rows[0] && rows[0].cnt > 0);
}

let ensureOutrosEjcsObsPromise = null;

async function ensureObservacoesStructure() {
    if (ensureOutrosEjcsObsPromise) return ensureOutrosEjcsObsPromise;
    ensureOutrosEjcsObsPromise = (async () => {
        if (!await hasColumn('outros_ejcs', 'observacoes')) {
            try {
                await db.pool.query('ALTER TABLE outros_ejcs ADD COLUMN observacoes VARCHAR(255) NULL AFTER bairro');
            } catch (err) {
                if (!err || err.code !== 'ER_DUP_FIELDNAME') throw err;
            }
        }

        await db.pool.query(`
            CREATE TABLE IF NOT EXISTS outros_ejcs_observacoes_extras (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tenant_id INT NOT NULL,
                outro_ejc_id INT NOT NULL,
                observacao TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                KEY idx_outros_ejcs_obs_tenant_outro (tenant_id, outro_ejc_id)
            )
        `);
    })();
    try {
        await ensureOutrosEjcsObsPromise;
    } finally {
        ensureOutrosEjcsObsPromise = null;
    }
}

// GET /api/outros-ejcs
router.get('/', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        await ensureObservacoesStructure();
        const [rows] = await db.pool.query('SELECT * FROM outros_ejcs WHERE tenant_id = ? ORDER BY created_at DESC', [tenantId]);
        res.json(rows);
    } catch (error) {
        console.error("Erro ao listar outros EJCs:", error);
        res.status(500).json({ error: 'Erro ao listar outros EJCs' });
    }
});

// GET /api/outros-ejcs/:id/presencas
router.get('/:id/presencas', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'ID inválido.' });
    }

    try {
        const tenantId = getTenantId(req);
        const hasPresencas = await hasTable('formularios_presencas');
        const hasFormularios = await hasTable('formularios_itens');
        const hasOutroEjcId = hasPresencas ? await hasColumn('formularios_presencas', 'outro_ejc_id') : false;
        if (!hasPresencas || !hasFormularios || !hasOutroEjcId) return res.json([]);

        const [rows] = await db.pool.query(`
            SELECT
                fp.id,
                fp.nome_completo,
                fp.telefone,
                fp.registrado_em,
                fi.titulo AS evento_titulo,
                fi.evento_data
            FROM formularios_presencas fp
            JOIN formularios_itens fi ON fi.id = fp.formulario_id
            WHERE fp.outro_ejc_id = ?
              AND fp.tenant_id = ?
            ORDER BY fp.registrado_em DESC
        `, [id, tenantId]);

        const map = new Map();
        for (const row of rows) {
            const nome = String(row.nome_completo || '').trim() || 'Sem nome';
            const telefone = String(row.telefone || '').trim() || '';
            const key = `${nome}::${telefone}`;
            const evento = {
                titulo: row.evento_titulo || 'Evento sem título',
                data: row.evento_data || null,
                registrado_em: row.registrado_em || null
            };

            if (!map.has(key)) {
                map.set(key, {
                    nome_completo: nome,
                    telefone: telefone || '-',
                    eventos: [evento]
                });
            } else {
                map.get(key).eventos.push(evento);
            }
        }

        return res.json(Array.from(map.values()));
    } catch (error) {
        console.error('Erro ao listar presenças por outro EJC:', error);
        return res.status(500).json({ error: 'Erro ao listar presenças.' });
    }
});

// GET /api/outros-ejcs/:id/conjuges
router.get('/:id/conjuges', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'ID inválido.' });
    }

    try {
        const tenantId = getTenantId(req);
        const hasJovens = await hasTable('jovens');
        if (!hasJovens) return res.json([]);

        const hasConjugeOutroEjcId = await hasColumn('jovens', 'conjuge_outro_ejc_id');
        const hasConjugeNome = await hasColumn('jovens', 'conjuge_nome');
        const hasConjugeTelefone = await hasColumn('jovens', 'conjuge_telefone');
        if (!hasConjugeOutroEjcId || !hasConjugeNome || !hasConjugeTelefone) return res.json([]);

        const [rows] = await db.pool.query(`
            SELECT
                j.id AS jovem_id,
                j.nome_completo AS jovem_nome,
                j.telefone AS jovem_telefone,
                j.conjuge_nome,
                j.conjuge_telefone
            FROM jovens j
            WHERE j.conjuge_outro_ejc_id = ?
              AND j.tenant_id = ?
              AND COALESCE(TRIM(j.conjuge_nome), '') <> ''
            ORDER BY j.conjuge_nome ASC, j.nome_completo ASC
        `, [id, tenantId]);

        const payload = rows.map(r => ({
            jovem_id: r.jovem_id,
            jovem_nome: r.jovem_nome || '-',
            conjuge_nome: r.conjuge_nome || '-',
            telefone: r.conjuge_telefone || r.jovem_telefone || '-'
        }));

        return res.json(payload);
    } catch (error) {
        console.error('Erro ao listar cônjuges por outro EJC:', error);
        return res.status(500).json({ error: 'Erro ao listar cônjuges.' });
    }
});

router.get('/:id/jovens', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'ID inválido.' });
    }

    try {
        const tenantId = getTenantId(req);
        const [rows] = await db.pool.query(
            `SELECT j.id, j.nome_completo, j.telefone, j.outro_ejc_numero,
                    j.estado_civil, j.sexo, j.circulo
             FROM jovens j
             WHERE j.tenant_id = ?
               AND j.origem_ejc_tipo = 'OUTRO_EJC'
               AND COALESCE(j.transferencia_outro_ejc, 0) = 0
               AND j.outro_ejc_id = ?
             ORDER BY j.nome_completo ASC`,
            [tenantId, id]
        );
        return res.json(rows || []);
    } catch (error) {
        console.error('Erro ao listar jovens do outro EJC:', error);
        return res.status(500).json({ error: 'Erro ao listar jovens deste outro EJC.' });
    }
});

router.get('/:id/observacoes', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'ID inválido.' });
    }

    try {
        const tenantId = getTenantId(req);
        await ensureObservacoesStructure();
        const [rows] = await db.pool.query(
            `SELECT id, observacao, created_at
             FROM outros_ejcs_observacoes_extras
             WHERE tenant_id = ? AND outro_ejc_id = ?
             ORDER BY created_at DESC, id DESC`,
            [tenantId, id]
        );
        return res.json(rows || []);
    } catch (error) {
        console.error('Erro ao listar observações extras do outro EJC:', error);
        return res.status(500).json({ error: 'Erro ao listar observações.' });
    }
});

router.post('/:id/observacoes', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'ID inválido.' });
    }

    try {
        const tenantId = getTenantId(req);
        await ensureObservacoesStructure();
        const observacao = String(req.body && req.body.observacao || '').trim();
        if (!observacao) {
            return res.status(400).json({ error: 'Informe a observação.' });
        }

        const [rows] = await db.pool.query(
            'SELECT id FROM outros_ejcs WHERE id = ? AND tenant_id = ? LIMIT 1',
            [id, tenantId]
        );
        if (!rows.length) {
            return res.status(404).json({ error: 'Outro EJC não encontrado.' });
        }

        const [result] = await db.pool.query(
            `INSERT INTO outros_ejcs_observacoes_extras (tenant_id, outro_ejc_id, observacao)
             VALUES (?, ?, ?)`,
            [tenantId, id, observacao]
        );
        return res.status(201).json({ id: result.insertId, message: 'Observação adicionada com sucesso.' });
    } catch (error) {
        console.error('Erro ao salvar observação extra do outro EJC:', error);
        return res.status(500).json({ error: 'Erro ao salvar observação.' });
    }
});

// POST /api/outros-ejcs
router.post('/', async (req, res) => {
    const { nome, paroquia, bairro, observacoes } = req.body;
    try {
        const tenantId = getTenantId(req);
        await ensureObservacoesStructure();
        if (!nome) {
            return res.status(400).json({ error: 'O nome do EJC é obrigatório.' });
        }
        const paroquiaValue = String(paroquia || '').trim();
        const bairroValue = String(bairro || '').trim();
        const [result] = await db.pool.query(
            'INSERT INTO outros_ejcs (tenant_id, nome, paroquia, bairro, observacoes) VALUES (?, ?, ?, ?, ?)',
            [tenantId, String(nome).trim(), paroquiaValue, bairroValue, String(observacoes || '').trim() || null]
        );
        res.status(201).json({ message: 'Outro EJC criado com sucesso!', id: result.insertId });
    } catch (error) {
        console.error("Erro ao criar outro EJC:", error);
        res.status(500).json({ error: 'Erro ao criar outro EJC' });
    }
});

// PUT /api/outros-ejcs/:id
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { nome, paroquia, bairro, observacoes } = req.body;
    try {
        const tenantId = getTenantId(req);
        await ensureObservacoesStructure();
        if (!nome) {
            return res.status(400).json({ error: 'O nome do EJC é obrigatório.' });
        }
        const paroquiaValue = String(paroquia || '').trim();
        const bairroValue = String(bairro || '').trim();
        const [result] = await db.pool.query(
            'UPDATE outros_ejcs SET nome = ?, paroquia = ?, bairro = ?, observacoes = ? WHERE id = ? AND tenant_id = ?',
            [String(nome).trim(), paroquiaValue, bairroValue, String(observacoes || '').trim() || null, id, tenantId]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Outro EJC não encontrado.' });
        }
        res.json({ message: 'Outro EJC atualizado com sucesso!' });
    } catch (error) {
        console.error("Erro ao atualizar outro EJC:", error);
        res.status(500).json({ error: 'Erro ao atualizar outro EJC' });
    }
});

// DELETE /api/outros-ejcs/:id
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const tenantId = getTenantId(req);
        const outroId = Number(id);
        if (!Number.isInteger(outroId) || outroId <= 0) {
            return res.status(400).json({ error: 'ID inválido.' });
        }

        const bloqueios = [];

        if (await hasTable('garcons_equipes')) {
            const hasCol = await hasColumn('garcons_equipes', 'outro_ejc_id');
            if (hasCol) {
                const [[row]] = await db.pool.query(
                    'SELECT COUNT(*) AS total FROM garcons_equipes WHERE outro_ejc_id = ?',
                    [outroId]
                );
                const total = Number(row && row.total || 0);
                if (total > 0) bloqueios.push(`Garçons (${total})`);
            }
        }

        if (await hasTable('jovens')) {
            const hasCol = await hasColumn('jovens', 'outro_ejc_id');
            if (hasCol) {
                const [[row]] = await db.pool.query(
                    'SELECT COUNT(*) AS total FROM jovens WHERE outro_ejc_id = ? AND tenant_id = ?',
                    [outroId, tenantId]
                );
                const total = Number(row && row.total || 0);
                if (total > 0) bloqueios.push(`Jovens de outro EJC (${total})`);
            }
        }

        if (await hasTable('formularios_presencas')) {
            const hasCol = await hasColumn('formularios_presencas', 'outro_ejc_id');
            if (hasCol) {
                const [[row]] = await db.pool.query(
                    'SELECT COUNT(*) AS total FROM formularios_presencas WHERE outro_ejc_id = ? AND tenant_id = ?',
                    [outroId, tenantId]
                );
                const total = Number(row && row.total || 0);
                if (total > 0) bloqueios.push(`Presenças (${total})`);
            }
        }

        if (bloqueios.length) {
            return res.status(409).json({
                error: `Não é possível excluir este EJC. Existem vínculos em: ${bloqueios.join(', ')}. Remova esses vínculos antes de excluir.`
            });
        }

        const [result] = await db.pool.query('DELETE FROM outros_ejcs WHERE id = ? AND tenant_id = ?', [id, tenantId]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Outro EJC não encontrado.' });
        }
        res.json({ message: 'Outro EJC excluído com sucesso!' });
    } catch (error) {
        console.error("Erro ao excluir outro EJC:", error);
        res.status(500).json({ error: 'Erro ao excluir outro EJC' });
    }
});

module.exports = router;
