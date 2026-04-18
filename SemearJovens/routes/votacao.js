const express = require('express');
const router = express.Router();
const { pool } = require('../database');

async function hasColumn(tableName, columnName) {
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS total
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
    `, [tableName, columnName]);
    return !!(rows && rows[0] && Number(rows[0].total) > 0);
}

async function ensureVotingTenantStructure() {
    if (!await hasColumn('votacoes_pastas', 'tenant_id')) {
        await pool.query('ALTER TABLE votacoes_pastas ADD COLUMN tenant_id INT NULL AFTER id');
    }
    if (!await hasColumn('votacoes', 'tenant_id')) {
        await pool.query('ALTER TABLE votacoes ADD COLUMN tenant_id INT NULL AFTER id');
    }
    if (!await hasColumn('votacao_candidatos', 'tenant_id')) {
        await pool.query('ALTER TABLE votacao_candidatos ADD COLUMN tenant_id INT NULL AFTER candidato_id');
    }
    if (!await hasColumn('votos', 'tenant_id')) {
        await pool.query('ALTER TABLE votos ADD COLUMN tenant_id INT NULL AFTER id');
    }

    await pool.query('UPDATE votacoes_pastas SET tenant_id = 1 WHERE tenant_id IS NULL');
    await pool.query(`
        UPDATE votacoes v
        JOIN votacoes_pastas vp ON vp.id = v.pasta_id
        SET v.tenant_id = vp.tenant_id
        WHERE v.tenant_id IS NULL
    `);
    await pool.query(`
        UPDATE votacao_candidatos vc
        JOIN votacoes v ON v.id = vc.votacao_id
        SET vc.tenant_id = v.tenant_id
        WHERE vc.tenant_id IS NULL
    `);
    await pool.query(`
        UPDATE votos vt
        JOIN votacoes v ON v.id = vt.votacao_id
        SET vt.tenant_id = v.tenant_id
        WHERE vt.tenant_id IS NULL
    `);
}

function getTenantId(req) {
    return Number(req && req.user && req.user.tenant_id);
}

function ensureTenantAccess(req, res) {
    const tenantId = getTenantId(req);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
        res.status(401).json({ error: 'Tenant não identificado para votação.' });
        return null;
    }
    return tenantId;
}

// GET /pastas - Listar pastas
router.get('/pastas', async (req, res) => {
    const tenantId = ensureTenantAccess(req, res);
    if (!tenantId) return;

    try {
        await ensureVotingTenantStructure();
        const [rows] = await pool.query(
            'SELECT * FROM votacoes_pastas WHERE tenant_id = ? ORDER BY data_criacao DESC',
            [tenantId]
        );
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao listar pastas' });
    }
});

// POST /pastas - Criar pasta
router.post('/pastas', async (req, res) => {
    const tenantId = ensureTenantAccess(req, res);
    if (!tenantId) return;

    const nome = String(req.body.nome || '').trim();
    if (!nome) return res.status(400).json({ error: 'Nome da pasta é obrigatório' });

    try {
        await ensureVotingTenantStructure();
        const [result] = await pool.query(
            'INSERT INTO votacoes_pastas (tenant_id, nome) VALUES (?, ?)',
            [tenantId, nome]
        );
        res.json({ id: result.insertId, nome, tenant_id: tenantId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao criar pasta' });
    }
});

// GET /pastas/:id/votacoes - Listar votações de uma pasta
router.get('/pastas/:id/votacoes', async (req, res) => {
    const tenantId = ensureTenantAccess(req, res);
    if (!tenantId) return;

    const pastaId = Number(req.params.id);
    if (!Number.isInteger(pastaId) || pastaId <= 0) {
        return res.status(400).json({ error: 'Pasta inválida' });
    }

    try {
        await ensureVotingTenantStructure();
        const [rows] = await pool.query(
            'SELECT * FROM votacoes WHERE tenant_id = ? AND pasta_id = ? ORDER BY data_criacao DESC',
            [tenantId, pastaId]
        );
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao listar votações da pasta' });
    }
});

// POST / - Criar votação
router.post('/', async (req, res) => {
    const tenantId = ensureTenantAccess(req, res);
    if (!tenantId) return;

    const titulo = String(req.body.titulo || '').trim();
    const pastaId = Number(req.body.pasta_id);
    const candidatosIds = Array.isArray(req.body.candidatos_ids)
        ? req.body.candidatos_ids.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)
        : [];

    if (!titulo || !Number.isInteger(pastaId) || pastaId <= 0 || !candidatosIds.length) {
        return res.status(400).json({ error: 'Dados inválidos: Título, Pasta e Candidatos são obrigatórios.' });
    }

    const connection = await pool.getConnection();
    try {
        await ensureVotingTenantStructure();
        await connection.beginTransaction();

        const [[pasta]] = await connection.query(
            'SELECT id FROM votacoes_pastas WHERE id = ? AND tenant_id = ? LIMIT 1',
            [pastaId, tenantId]
        );
        if (!pasta) {
            await connection.rollback();
            return res.status(404).json({ error: 'Pasta não encontrada neste tenant.' });
        }

        const [validCandidates] = await connection.query(
            'SELECT id FROM jovens WHERE tenant_id = ? AND id IN (?)',
            [tenantId, candidatosIds]
        );
        if (validCandidates.length !== candidatosIds.length) {
            await connection.rollback();
            return res.status(400).json({ error: 'Há candidatos inválidos para este tenant.' });
        }

        const [result] = await connection.query(
            'INSERT INTO votacoes (tenant_id, titulo, pasta_id) VALUES (?, ?, ?)',
            [tenantId, titulo, pastaId]
        );
        const votacaoId = result.insertId;

        for (const candidatoId of candidatosIds) {
            await connection.query(
                'INSERT INTO votacao_candidatos (votacao_id, candidato_id, tenant_id) VALUES (?, ?, ?)',
                [votacaoId, candidatoId, tenantId]
            );
        }

        await connection.commit();
        res.json({ id: votacaoId, message: 'Votação criada com sucesso' });
    } catch (err) {
        await connection.rollback();
        console.error(err);
        res.status(500).json({ error: 'Erro ao criar votação' });
    } finally {
        connection.release();
    }
});

// GET /:id - Obter detalhes da votação
router.get('/:id', async (req, res) => {
    const tenantId = ensureTenantAccess(req, res);
    if (!tenantId) return;

    const votacaoId = Number(req.params.id);
    if (!Number.isInteger(votacaoId) || votacaoId <= 0) {
        return res.status(400).json({ error: 'Votação inválida' });
    }

    try {
        await ensureVotingTenantStructure();
        const [votacao] = await pool.query(
            'SELECT * FROM votacoes WHERE id = ? AND tenant_id = ?',
            [votacaoId, tenantId]
        );
        if (!votacao.length) return res.status(404).json({ error: 'Votação não encontrada' });

        const [candidatos] = await pool.query(`
            SELECT j.id, j.nome_completo
            FROM votacao_candidatos vc
            JOIN jovens j ON vc.candidato_id = j.id AND j.tenant_id = vc.tenant_id
            WHERE vc.votacao_id = ? AND vc.tenant_id = ?
            ORDER BY j.nome_completo
        `, [votacaoId, tenantId]);

        const [eleitores] = await pool.query(
            'SELECT id, nome_completo FROM usuarios WHERE tenant_id = ? ORDER BY nome_completo',
            [tenantId]
        );

        const [votos] = await pool.query(
            'SELECT eleitor_id, candidato_id, pontos FROM votos WHERE votacao_id = ? AND tenant_id = ?',
            [votacaoId, tenantId]
        );

        res.json({
            votacao: votacao[0],
            candidatos,
            eleitores,
            votos
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao carregar dados da votação' });
    }
});

// POST /:id/votos_lote - Salvar votos
router.post('/:id/votos_lote', async (req, res) => {
    const tenantId = ensureTenantAccess(req, res);
    if (!tenantId) return;

    const votacaoId = Number(req.params.id);
    const votos = Array.isArray(req.body.votos) ? req.body.votos : null;
    if (!Number.isInteger(votacaoId) || votacaoId <= 0 || !votos) {
        return res.status(400).json({ error: 'Formato de votos inválido' });
    }

    const connection = await pool.getConnection();
    try {
        await ensureVotingTenantStructure();
        await connection.beginTransaction();

        const [[votacao]] = await connection.query(
            'SELECT id FROM votacoes WHERE id = ? AND tenant_id = ? LIMIT 1',
            [votacaoId, tenantId]
        );
        if (!votacao) {
            await connection.rollback();
            return res.status(404).json({ error: 'Votação não encontrada neste tenant.' });
        }

        for (const voto of votos) {
            const eleitorId = Number(voto && voto.eleitor_id);
            const candidatoId = Number(voto && voto.candidato_id);
            const pontos = voto && voto.pontos;
            if (!Number.isInteger(eleitorId) || eleitorId <= 0 || !Number.isInteger(candidatoId) || candidatoId <= 0) {
                continue;
            }

            const [[eleitor]] = await connection.query(
                'SELECT id FROM usuarios WHERE id = ? AND tenant_id = ? LIMIT 1',
                [eleitorId, tenantId]
            );
            const [[candidato]] = await connection.query(
                'SELECT id FROM votacao_candidatos WHERE votacao_id = ? AND candidato_id = ? AND tenant_id = ? LIMIT 1',
                [votacaoId, candidatoId, tenantId]
            );
            if (!eleitor || !candidato) continue;

            if (pontos === null || pontos === undefined || pontos === '') {
                await connection.query(
                    'DELETE FROM votos WHERE votacao_id = ? AND tenant_id = ? AND eleitor_id = ? AND candidato_id = ?',
                    [votacaoId, tenantId, eleitorId, candidatoId]
                );
            } else {
                await connection.query(`
                    INSERT INTO votos (tenant_id, votacao_id, eleitor_id, candidato_id, pontos)
                    VALUES (?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE pontos = VALUES(pontos)
                `, [tenantId, votacaoId, eleitorId, candidatoId, pontos]);
            }
        }

        await connection.commit();
        res.json({ message: 'Votos salvos com sucesso' });
    } catch (err) {
        await connection.rollback();
        console.error(err);
        res.status(500).json({ error: 'Erro ao salvar votos' });
    } finally {
        connection.release();
    }
});

// GET /:id/ranking - Calcular Ranking
router.get('/:id/ranking', async (req, res) => {
    const tenantId = ensureTenantAccess(req, res);
    if (!tenantId) return;

    const votacaoId = Number(req.params.id);
    if (!Number.isInteger(votacaoId) || votacaoId <= 0) {
        return res.status(400).json({ error: 'Votação inválida' });
    }

    try {
        await ensureVotingTenantStructure();
        const [ranking] = await pool.query(`
            SELECT
                j.nome_completo AS nome,
                COALESCE(SUM(v.pontos), 0) AS total_pontos
            FROM votacao_candidatos vc
            JOIN jovens j ON vc.candidato_id = j.id AND j.tenant_id = vc.tenant_id
            LEFT JOIN votos v ON v.votacao_id = vc.votacao_id AND v.candidato_id = j.id AND v.tenant_id = vc.tenant_id
            WHERE vc.votacao_id = ? AND vc.tenant_id = ?
            GROUP BY j.id, j.nome_completo
            ORDER BY total_pontos DESC, j.nome_completo ASC
        `, [votacaoId, tenantId]);

        res.json(ranking);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao calcular ranking' });
    }
});

// DELETE /:id - Excluir votação
router.delete('/:id', async (req, res) => {
    const tenantId = ensureTenantAccess(req, res);
    if (!tenantId) return;

    const votacaoId = Number(req.params.id);
    if (!Number.isInteger(votacaoId) || votacaoId <= 0) {
        return res.status(400).json({ error: 'Votação inválida' });
    }

    try {
        await ensureVotingTenantStructure();
        await pool.query('DELETE FROM votacoes WHERE id = ? AND tenant_id = ?', [votacaoId, tenantId]);
        res.json({ message: 'Votação excluída' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao excluir votação' });
    }
});

// DELETE /pastas/:id - Excluir pasta
router.delete('/pastas/:id', async (req, res) => {
    const tenantId = ensureTenantAccess(req, res);
    if (!tenantId) return;

    const pastaId = Number(req.params.id);
    if (!Number.isInteger(pastaId) || pastaId <= 0) {
        return res.status(400).json({ error: 'Pasta inválida' });
    }

    try {
        await ensureVotingTenantStructure();
        await pool.query('DELETE FROM votacoes_pastas WHERE id = ? AND tenant_id = ?', [pastaId, tenantId]);
        res.json({ message: 'Pasta excluída' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao excluir pasta' });
    }
});

module.exports = router;
