const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { getTenantId, ensureTenantIsolation } = require('../lib/tenantIsolation');

let estruturaGarantida = false;

async function hasColumn(tableName, columnName) {
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
    `, [tableName, columnName]);
    return !!(rows && rows[0] && rows[0].cnt > 0);
}

async function hasIndex(tableName, indexName) {
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND INDEX_NAME = ?
    `, [tableName, indexName]);
    return !!(rows && rows[0] && rows[0].cnt > 0);
}

async function garantirEstrutura() {
    if (estruturaGarantida) return;

    await ensureTenantIsolation();

    await pool.query(`
        CREATE TABLE IF NOT EXISTS coordenacoes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            nome VARCHAR(120) NOT NULL,
            pasta_id INT NULL,
            periodo VARCHAR(50) NULL,
            descricao TEXT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_coordenacoes_tenant (tenant_id)
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS coordenacoes_pastas (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            nome VARCHAR(120) NOT NULL,
            parent_id INT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_coord_pastas_tenant (tenant_id),
            KEY idx_coord_pastas_parent (parent_id)
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS coordenacoes_membros (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            coordenacao_id INT NOT NULL,
            jovem_id INT NULL,
            membro_tipo VARCHAR(10) NOT NULL DEFAULT 'JOVEM',
            tio_casal_id INT NULL,
            comissao_id INT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_coord_jovem (coordenacao_id, jovem_id),
            CONSTRAINT fk_coord_membro_coord FOREIGN KEY (coordenacao_id) REFERENCES coordenacoes(id) ON DELETE CASCADE,
            CONSTRAINT fk_coord_membro_jovem FOREIGN KEY (jovem_id) REFERENCES jovens(id) ON DELETE CASCADE,
            KEY idx_coord_membros_tenant (tenant_id)
        )
    `);

    for (const tableName of ['coordenacoes', 'coordenacoes_pastas', 'coordenacoes_membros']) {
        if (!(await hasColumn(tableName, 'tenant_id'))) {
            await pool.query(`ALTER TABLE ${tableName} ADD COLUMN tenant_id INT NULL AFTER id`);
        }
        await pool.query(`UPDATE ${tableName} SET tenant_id = 1 WHERE tenant_id IS NULL`);
        await pool.query(`ALTER TABLE ${tableName} MODIFY tenant_id INT NOT NULL`);
    }

    try {
        await pool.query('ALTER TABLE coordenacoes ADD COLUMN pasta_id INT NULL');
    } catch (_) { }
    try {
        await pool.query('ALTER TABLE coordenacoes_pastas ADD COLUMN parent_id INT NULL');
    } catch (_) { }
    try {
        await pool.query("ALTER TABLE coordenacoes_membros MODIFY jovem_id INT NULL");
    } catch (_) { }
    try {
        await pool.query("ALTER TABLE coordenacoes_membros ADD COLUMN membro_tipo VARCHAR(10) NOT NULL DEFAULT 'JOVEM' AFTER jovem_id");
    } catch (_) { }
    try {
        await pool.query("ALTER TABLE coordenacoes_membros ADD COLUMN tio_casal_id INT NULL AFTER membro_tipo");
    } catch (_) { }

    if (!(await hasIndex('coordenacoes', 'idx_coordenacoes_tenant'))) {
        await pool.query('ALTER TABLE coordenacoes ADD KEY idx_coordenacoes_tenant (tenant_id)');
    }
    if (!(await hasIndex('coordenacoes_pastas', 'idx_coord_pastas_tenant'))) {
        await pool.query('ALTER TABLE coordenacoes_pastas ADD KEY idx_coord_pastas_tenant (tenant_id)');
    }
    if (!(await hasIndex('coordenacoes_pastas', 'idx_coord_pastas_parent'))) {
        await pool.query('ALTER TABLE coordenacoes_pastas ADD KEY idx_coord_pastas_parent (parent_id)');
    }
    if (!(await hasIndex('coordenacoes_membros', 'idx_coord_membros_tenant'))) {
        await pool.query('ALTER TABLE coordenacoes_membros ADD KEY idx_coord_membros_tenant (tenant_id)');
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS jovens_comissoes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            jovem_id INT NOT NULL,
            tipo VARCHAR(120) NOT NULL,
            ejc_numero INT NULL,
            paroquia VARCHAR(255) NULL,
            data_inicio DATE NULL,
            data_fim DATE NULL,
            funcao_garcom VARCHAR(50) NULL,
            semestre VARCHAR(20) NULL,
            circulo VARCHAR(50) NULL,
            coordenacao_nome VARCHAR(120) NULL,
            observacao TEXT NULL,
            outro_ejc_id INT NULL,
            tenant_id INT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (jovem_id) REFERENCES jovens(id) ON DELETE CASCADE
        )
    `);
    try {
        await pool.query('ALTER TABLE jovens_comissoes MODIFY COLUMN tipo VARCHAR(120) NOT NULL');
    } catch (_) { }
    try {
        await pool.query('ALTER TABLE jovens_comissoes ADD COLUMN coordenacao_nome VARCHAR(120) NULL');
    } catch (_) { }

    estruturaGarantida = true;
}

router.get('/pastas', async (req, res) => {
    const tenantId = getTenantId(req);
    try {
        await garantirEstrutura();
        const [rows] = await pool.query(
            'SELECT id, nome, parent_id, created_at FROM coordenacoes_pastas WHERE tenant_id = ? ORDER BY nome ASC',
            [tenantId]
        );
        res.json(rows);
    } catch (err) {
        console.error('Erro ao listar pastas de coordenações:', err);
        res.status(500).json({ error: 'Erro ao listar pastas' });
    }
});

router.get('/historico/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });
    try {
        await garantirEstrutura();

        const [[coordAtual]] = await pool.query(
            `SELECT c.id, c.nome, c.pasta_id, p.nome AS pasta_nome
             FROM coordenacoes c
             LEFT JOIN coordenacoes_pastas p ON p.id = c.pasta_id AND p.tenant_id = c.tenant_id
             WHERE c.id = ? AND c.tenant_id = ? LIMIT 1`,
            [id, tenantId]
        );
        if (!coordAtual) return res.status(404).json({ error: 'Coordenação não encontrada.' });

        const [coordenacoes] = await pool.query(
            `SELECT c.id, c.nome, c.pasta_id, p.nome AS pasta_nome, c.periodo, c.descricao, c.created_at
             FROM coordenacoes c
             LEFT JOIN coordenacoes_pastas p ON p.id = c.pasta_id AND p.tenant_id = c.tenant_id
             WHERE c.tenant_id = ?
               AND COALESCE(c.pasta_id, 0) = COALESCE(?, 0)
             ORDER BY c.created_at DESC, c.id DESC`,
            [tenantId, coordAtual.pasta_id || null]
        );

        const ids = coordenacoes.map(c => c.id);
        let membros = [];
        if (ids.length) {
            const placeholders = ids.map(() => '?').join(', ');
            const [rowsMembros] = await pool.query(
                `SELECT cm.id, cm.coordenacao_id, cm.jovem_id, cm.tio_casal_id, cm.membro_tipo, cm.comissao_id,
                        j.nome_completo, j.telefone, j.circulo,
                        tc.nome_tio, tc.nome_tia, tc.telefone_tio, tc.telefone_tia
                 FROM coordenacoes_membros cm
                 LEFT JOIN jovens j ON j.id = cm.jovem_id AND j.tenant_id = cm.tenant_id
                 LEFT JOIN tios_casais tc ON tc.id = cm.tio_casal_id AND tc.tenant_id = cm.tenant_id
                 WHERE cm.tenant_id = ?
                   AND cm.coordenacao_id IN (${placeholders})
                 ORDER BY COALESCE(j.nome_completo, tc.nome_tio, tc.nome_tia) ASC`,
                [tenantId, ...ids]
            );
            membros = rowsMembros;
        }

        const mapa = new Map();
        coordenacoes.forEach(c => mapa.set(c.id, { ...c, membros: [] }));
        membros.forEach(m => {
            const item = mapa.get(m.coordenacao_id);
            if (!item) return;
            const tipo = (m.membro_tipo || 'JOVEM').toUpperCase();
            if (tipo === 'TIO') {
                item.membros.push({
                    id: m.id,
                    membro_tipo: 'TIO',
                    tio_casal_id: m.tio_casal_id,
                    nome_completo: [m.nome_tio, m.nome_tia].filter(Boolean).join(' e '),
                    telefone: m.telefone_tio || m.telefone_tia || '',
                    circulo: ''
                });
            } else {
                item.membros.push({
                    id: m.id,
                    membro_tipo: 'JOVEM',
                    jovem_id: m.jovem_id,
                    nome_completo: m.nome_completo,
                    telefone: m.telefone,
                    circulo: m.circulo
                });
            }
        });

        res.json({
            nome: coordAtual.pasta_nome || coordAtual.nome,
            gestoes: Array.from(mapa.values())
        });
    } catch (err) {
        console.error('Erro ao buscar histórico de coordenação:', err);
        res.status(500).json({ error: 'Erro ao buscar histórico de coordenação' });
    }
});

router.post('/pastas', async (req, res) => {
    const tenantId = getTenantId(req);
    const nome = String(req.body.nome || '').trim();
    const parentId = req.body.parent_id ? Number(req.body.parent_id) : null;
    if (!nome) return res.status(400).json({ error: 'Nome da pasta é obrigatório.' });

    try {
        await garantirEstrutura();
        if (parentId) {
            const [parentRows] = await pool.query(
                'SELECT id FROM coordenacoes_pastas WHERE id = ? AND tenant_id = ? LIMIT 1',
                [parentId, tenantId]
            );
            if (!parentRows.length) return res.status(404).json({ error: 'Pasta pai não encontrada.' });
        }
        const [exists] = await pool.query(
            `SELECT id
             FROM coordenacoes_pastas
             WHERE tenant_id = ?
               AND LOWER(nome)=LOWER(?)
               AND COALESCE(parent_id, 0)=COALESCE(?, 0)
             LIMIT 1`,
            [tenantId, nome, parentId || null]
        );
        if (exists.length) return res.status(409).json({ error: 'Já existe uma pasta com esse nome neste nível.' });

        const [result] = await pool.query(
            'INSERT INTO coordenacoes_pastas (tenant_id, nome, parent_id) VALUES (?, ?, ?)',
            [tenantId, nome, parentId || null]
        );
        res.status(201).json({ id: result.insertId, message: 'Pasta criada com sucesso' });
    } catch (err) {
        console.error('Erro ao criar pasta de coordenações:', err);
        res.status(500).json({ error: 'Erro ao criar pasta' });
    }
});

router.put('/pastas/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.id);
    const nome = String(req.body.nome || '').trim();
    const parentId = req.body.parent_id !== undefined ? (req.body.parent_id ? Number(req.body.parent_id) : null) : undefined;
    if (!id || !nome) return res.status(400).json({ error: 'Dados inválidos.' });

    try {
        await garantirEstrutura();
        const [rows] = await pool.query(
            'SELECT id, parent_id FROM coordenacoes_pastas WHERE id = ? AND tenant_id = ? LIMIT 1',
            [id, tenantId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Pasta não encontrada.' });

        const parentFinal = parentId === undefined ? (rows[0].parent_id || null) : parentId;
        if (parentFinal && Number(parentFinal) === id) {
            return res.status(400).json({ error: 'A pasta não pode ser filha dela mesma.' });
        }
        if (parentFinal) {
            const [parentRows] = await pool.query(
                'SELECT id FROM coordenacoes_pastas WHERE id = ? AND tenant_id = ? LIMIT 1',
                [parentFinal, tenantId]
            );
            if (!parentRows.length) return res.status(404).json({ error: 'Pasta pai não encontrada.' });
        }

        const [dup] = await pool.query(
            `SELECT id
             FROM coordenacoes_pastas
             WHERE tenant_id = ?
               AND LOWER(nome)=LOWER(?)
               AND COALESCE(parent_id, 0)=COALESCE(?, 0)
               AND id <> ?
             LIMIT 1`,
            [tenantId, nome, parentFinal || null, id]
        );
        if (dup.length) return res.status(409).json({ error: 'Já existe uma pasta com esse nome neste nível.' });

        await pool.query(
            'UPDATE coordenacoes_pastas SET nome = ?, parent_id = ? WHERE id = ? AND tenant_id = ?',
            [nome, parentFinal || null, id, tenantId]
        );
        res.json({ message: 'Pasta atualizada com sucesso' });
    } catch (err) {
        console.error('Erro ao atualizar pasta de coordenações:', err);
        res.status(500).json({ error: 'Erro ao atualizar pasta' });
    }
});

router.delete('/pastas/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });

    const connection = await pool.getConnection();
    try {
        await garantirEstrutura();
        await connection.beginTransaction();

        const [filhas] = await connection.query(
            'SELECT id FROM coordenacoes_pastas WHERE parent_id = ? AND tenant_id = ? LIMIT 1',
            [id, tenantId]
        );
        if (filhas.length) {
            await connection.rollback();
            return res.status(409).json({ error: 'Esta pasta possui subpastas. Remova as subpastas primeiro.' });
        }

        await connection.query(
            'UPDATE coordenacoes SET pasta_id = NULL WHERE pasta_id = ? AND tenant_id = ?',
            [id, tenantId]
        );
        await connection.query(
            'DELETE FROM coordenacoes_pastas WHERE id = ? AND tenant_id = ?',
            [id, tenantId]
        );

        await connection.commit();
        res.json({ message: 'Pasta removida com sucesso' });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao remover pasta de coordenações:', err);
        res.status(500).json({ error: 'Erro ao remover pasta' });
    } finally {
        connection.release();
    }
});

router.get('/', async (req, res) => {
    const tenantId = getTenantId(req);
    try {
        await garantirEstrutura();
        const [coordenacoes] = await pool.query(
            `SELECT c.id, c.nome, c.pasta_id, p.nome AS pasta_nome, c.periodo, c.descricao, c.created_at
             FROM coordenacoes c
             LEFT JOIN coordenacoes_pastas p ON p.id = c.pasta_id AND p.tenant_id = c.tenant_id
             WHERE c.tenant_id = ?
             ORDER BY COALESCE(p.nome, 'zzzz'), c.created_at DESC, c.id DESC`,
            [tenantId]
        );
        const [membros] = await pool.query(`
            SELECT cm.id, cm.coordenacao_id, cm.jovem_id, cm.tio_casal_id, cm.membro_tipo, cm.comissao_id,
                   j.nome_completo, j.telefone, j.circulo,
                   tc.nome_tio, tc.nome_tia, tc.telefone_tio, tc.telefone_tia
            FROM coordenacoes_membros cm
            LEFT JOIN jovens j ON j.id = cm.jovem_id AND j.tenant_id = cm.tenant_id
            LEFT JOIN tios_casais tc ON tc.id = cm.tio_casal_id AND tc.tenant_id = cm.tenant_id
            WHERE cm.tenant_id = ?
            ORDER BY COALESCE(j.nome_completo, tc.nome_tio, tc.nome_tia) ASC
        `, [tenantId]);

        const mapa = new Map();
        coordenacoes.forEach(c => mapa.set(c.id, { ...c, membros: [] }));
        membros.forEach(m => {
            const item = mapa.get(m.coordenacao_id);
            if (!item) return;
            const tipo = (m.membro_tipo || 'JOVEM').toUpperCase();
            if (tipo === 'TIO') {
                item.membros.push({
                    id: m.id,
                    membro_tipo: 'TIO',
                    tio_casal_id: m.tio_casal_id,
                    nome_completo: [m.nome_tio, m.nome_tia].filter(Boolean).join(' e '),
                    telefone: m.telefone_tio || m.telefone_tia || '',
                    circulo: ''
                });
            } else {
                item.membros.push({
                    id: m.id,
                    membro_tipo: 'JOVEM',
                    jovem_id: m.jovem_id,
                    nome_completo: m.nome_completo,
                    telefone: m.telefone,
                    circulo: m.circulo
                });
            }
        });
        res.json(Array.from(mapa.values()));
    } catch (err) {
        console.error('Erro ao listar coordenações:', err);
        res.status(500).json({ error: 'Erro ao listar coordenações' });
    }
});

router.post('/', async (req, res) => {
    const tenantId = getTenantId(req);
    const pastaId = req.body.pasta_id ? Number(req.body.pasta_id) : null;
    const periodo = String(req.body.periodo || '').trim();
    const descricao = String(req.body.descricao || '').trim();
    if (!pastaId) return res.status(400).json({ error: 'Selecione uma pasta para criar a coordenação.' });
    if (!periodo) return res.status(400).json({ error: 'Período é obrigatório.' });

    try {
        await garantirEstrutura();
        const [pastaRows] = await pool.query(
            'SELECT id, nome FROM coordenacoes_pastas WHERE id = ? AND tenant_id = ? LIMIT 1',
            [pastaId, tenantId]
        );
        if (!pastaRows.length) return res.status(404).json({ error: 'Pasta não encontrada.' });
        const nomeCoordenacao = String(pastaRows[0].nome || '').trim();

        const [exists] = await pool.query(
            `SELECT id
             FROM coordenacoes
             WHERE tenant_id = ?
               AND COALESCE(pasta_id, 0) = COALESCE(?, 0)
               AND LOWER(COALESCE(periodo, '')) = LOWER(COALESCE(?, ''))
             LIMIT 1`,
            [tenantId, pastaId || null, periodo || null]
        );
        if (exists.length) return res.status(409).json({ error: 'Já existe um registro com esse período nesta coordenação.' });

        const [result] = await pool.query(
            'INSERT INTO coordenacoes (tenant_id, nome, pasta_id, periodo, descricao) VALUES (?, ?, ?, ?, ?)',
            [tenantId, nomeCoordenacao, pastaId || null, periodo || null, descricao || null]
        );
        res.status(201).json({ id: result.insertId, message: 'Coordenação criada com sucesso' });
    } catch (err) {
        console.error('Erro ao criar coordenação:', err);
        res.status(500).json({ error: 'Erro ao criar coordenação' });
    }
});

router.put('/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.id);
    const pastaId = req.body.pasta_id ? Number(req.body.pasta_id) : null;
    const periodo = String(req.body.periodo || '').trim();
    const descricao = String(req.body.descricao || '').trim();
    if (!id) return res.status(400).json({ error: 'Dados inválidos.' });
    if (!pastaId) return res.status(400).json({ error: 'Selecione uma pasta para salvar a coordenação.' });
    if (!periodo) return res.status(400).json({ error: 'Período é obrigatório.' });

    const connection = await pool.getConnection();
    try {
        await garantirEstrutura();
        await connection.beginTransaction();

        const [rows] = await connection.query(
            'SELECT id FROM coordenacoes WHERE id = ? AND tenant_id = ? LIMIT 1',
            [id, tenantId]
        );
        if (!rows.length) {
            await connection.rollback();
            return res.status(404).json({ error: 'Coordenação não encontrada.' });
        }

        const [pastaRows] = await connection.query(
            'SELECT id, nome FROM coordenacoes_pastas WHERE id = ? AND tenant_id = ? LIMIT 1',
            [pastaId, tenantId]
        );
        if (!pastaRows.length) {
            await connection.rollback();
            return res.status(404).json({ error: 'Pasta não encontrada.' });
        }
        const nomeCoordenacao = String(pastaRows[0].nome || '').trim();

        const [exists] = await connection.query(
            `SELECT id
             FROM coordenacoes
             WHERE tenant_id = ?
               AND COALESCE(pasta_id, 0)=COALESCE(?, 0)
               AND LOWER(COALESCE(periodo, '')) = LOWER(COALESCE(?, ''))
               AND id <> ?
             LIMIT 1`,
            [tenantId, pastaId || null, periodo || null, id]
        );
        if (exists.length) {
            await connection.rollback();
            return res.status(409).json({ error: 'Já existe um registro com esse período nesta coordenação.' });
        }

        await connection.query(
            'UPDATE coordenacoes SET nome = ?, pasta_id = ?, periodo = ?, descricao = ? WHERE id = ? AND tenant_id = ?',
            [nomeCoordenacao, pastaId || null, periodo || null, descricao || null, id, tenantId]
        );

        await connection.query(
            `UPDATE jovens_comissoes jc
             JOIN coordenacoes_membros cm ON cm.comissao_id = jc.id AND cm.tenant_id = jc.tenant_id
             SET jc.coordenacao_nome = ?, jc.semestre = ?
             WHERE cm.coordenacao_id = ?
               AND cm.tenant_id = ?
               AND jc.tenant_id = ?`,
            [nomeCoordenacao, periodo || null, id, tenantId, tenantId]
        );

        await connection.commit();
        res.json({ message: 'Coordenação atualizada com sucesso' });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao atualizar coordenação:', err);
        res.status(500).json({ error: 'Erro ao atualizar coordenação' });
    } finally {
        connection.release();
    }
});

router.delete('/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });

    const connection = await pool.getConnection();
    try {
        await garantirEstrutura();
        await connection.beginTransaction();

        const [membros] = await connection.query(
            'SELECT comissao_id FROM coordenacoes_membros WHERE coordenacao_id = ? AND tenant_id = ?',
            [id, tenantId]
        );
        const idsComissao = membros.map(m => m.comissao_id).filter(Boolean);
        if (idsComissao.length) {
            const placeholders = idsComissao.map(() => '?').join(', ');
            await connection.query(
                `DELETE FROM jovens_comissoes WHERE tenant_id = ? AND id IN (${placeholders})`,
                [tenantId, ...idsComissao]
            );
        }

        await connection.query(
            'DELETE FROM coordenacoes_membros WHERE coordenacao_id = ? AND tenant_id = ?',
            [id, tenantId]
        );
        await connection.query(
            'DELETE FROM coordenacoes WHERE id = ? AND tenant_id = ?',
            [id, tenantId]
        );

        await connection.commit();
        res.json({ message: 'Coordenação removida com sucesso' });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao remover coordenação:', err);
        res.status(500).json({ error: 'Erro ao remover coordenação' });
    } finally {
        connection.release();
    }
});

router.post('/:id/membros', async (req, res) => {
    const tenantId = getTenantId(req);
    const coordenacaoId = Number(req.params.id);
    const tipo = String(req.body.tipo || 'JOVEM').toUpperCase();
    const jovemId = req.body.jovem_id ? Number(req.body.jovem_id) : null;
    const tioId = req.body.tio_casal_id ? Number(req.body.tio_casal_id) : null;
    if (!coordenacaoId) return res.status(400).json({ error: 'Dados inválidos.' });
    if (tipo === 'TIO' && !tioId) return res.status(400).json({ error: 'Selecione um tio.' });
    if (tipo !== 'TIO' && !jovemId) return res.status(400).json({ error: 'Selecione um jovem.' });

    const connection = await pool.getConnection();
    try {
        await garantirEstrutura();
        await connection.beginTransaction();

        const [[coord]] = await connection.query(
            'SELECT id, nome, periodo FROM coordenacoes WHERE id = ? AND tenant_id = ? LIMIT 1',
            [coordenacaoId, tenantId]
        );
        if (!coord) {
            await connection.rollback();
            return res.status(404).json({ error: 'Coordenação não encontrada.' });
        }

        if (tipo === 'TIO') {
            const [[tio]] = await connection.query(
                'SELECT id FROM tios_casais WHERE id = ? AND tenant_id = ? LIMIT 1',
                [tioId, tenantId]
            );
            if (!tio) {
                await connection.rollback();
                return res.status(404).json({ error: 'Tio não encontrado.' });
            }
        } else {
            const [[jovem]] = await connection.query(
                'SELECT id FROM jovens WHERE id = ? AND tenant_id = ? LIMIT 1',
                [jovemId, tenantId]
            );
            if (!jovem) {
                await connection.rollback();
                return res.status(404).json({ error: 'Jovem não encontrado.' });
            }
        }

        const [jaExiste] = await connection.query(
            `SELECT id
             FROM coordenacoes_membros
             WHERE tenant_id = ?
               AND coordenacao_id = ?
               AND ((membro_tipo = "TIO" AND tio_casal_id = ?) OR (membro_tipo <> "TIO" AND jovem_id = ?))
             LIMIT 1`,
            [tenantId, coordenacaoId, tioId || 0, jovemId || 0]
        );
        if (jaExiste.length) {
            await connection.rollback();
            return res.status(409).json({ error: 'Este membro já está nesta coordenação.' });
        }

        let comissaoId = null;
        if (tipo !== 'TIO') {
            const [comissaoResult] = await connection.query(
                `INSERT INTO jovens_comissoes 
                 (tenant_id, jovem_id, tipo, semestre, coordenacao_nome, observacao)
                 VALUES (?, ?, 'COORDENACAO', ?, ?, ?)`,
                [tenantId, jovemId, coord.periodo || null, coord.nome, null]
            );
            comissaoId = comissaoResult.insertId;
        }

        await connection.query(
            `INSERT INTO coordenacoes_membros
             (tenant_id, coordenacao_id, jovem_id, membro_tipo, tio_casal_id, comissao_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [tenantId, coordenacaoId, jovemId || null, tipo === 'TIO' ? 'TIO' : 'JOVEM', tioId || null, comissaoId]
        );

        await connection.commit();
        res.status(201).json({ message: 'Membro adicionado à coordenação' });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao adicionar membro na coordenação:', err);
        const msg = err && (err.sqlMessage || err.message) ? (err.sqlMessage || err.message) : 'Erro ao adicionar membro na coordenação';
        res.status(500).json({ error: msg });
    } finally {
        connection.release();
    }
});

router.delete('/membros/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    const membroId = Number(req.params.id);
    if (!membroId) return res.status(400).json({ error: 'ID inválido.' });

    const connection = await pool.getConnection();
    try {
        await garantirEstrutura();
        await connection.beginTransaction();

        const [[membro]] = await connection.query(
            'SELECT id, comissao_id FROM coordenacoes_membros WHERE id = ? AND tenant_id = ? LIMIT 1',
            [membroId, tenantId]
        );
        if (!membro) {
            await connection.rollback();
            return res.status(404).json({ error: 'Vínculo não encontrado.' });
        }

        if (membro.comissao_id) {
            await connection.query(
                'DELETE FROM jovens_comissoes WHERE id = ? AND tenant_id = ?',
                [membro.comissao_id, tenantId]
            );
        }
        await connection.query(
            'DELETE FROM coordenacoes_membros WHERE id = ? AND tenant_id = ?',
            [membroId, tenantId]
        );

        await connection.commit();
        res.json({ message: 'Jovem removido da coordenação' });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao remover jovem da coordenação:', err);
        res.status(500).json({ error: 'Erro ao remover jovem da coordenação' });
    } finally {
        connection.release();
    }
});

module.exports = router;
