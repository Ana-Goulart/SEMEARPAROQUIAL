const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { getTenantId } = require('../lib/tenantIsolation');

let garantirEstruturaPromise = null;

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

async function isNullable(tableName, columnName) {
    const [rows] = await pool.query(`
        SELECT IS_NULLABLE
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
        LIMIT 1
    `, [tableName, columnName]);
    return rows && rows[0] && rows[0].IS_NULLABLE === 'YES';
}

async function runAlterIgnoreDuplicate(sql) {
    try {
        await pool.query(sql);
    } catch (err) {
        if (err && (err.code === 'ER_DUP_FIELDNAME' || err.code === 'ER_DUP_KEYNAME')) return;
        throw err;
    }
}

async function tryDropIndex(tableName, indexName) {
    try {
        await pool.query(`ALTER TABLE \`${tableName}\` DROP INDEX \`${indexName}\``);
    } catch (err) {
        if (err && (err.code === 'ER_CANT_DROP_FIELD_OR_KEY' || err.code === 'ER_DROP_INDEX_FK')) return;
        console.error(`[ataReunioes] Falha ao remover índice ${tableName}.${indexName}:`, err.message || err);
    }
}

async function _doGarantirEstrutura() {

    await pool.query(`
        CREATE TABLE IF NOT EXISTS funcoes_dirigencia (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NULL,
            nome VARCHAR(160) NOT NULL,
            descricao TEXT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await runAlterIgnoreDuplicate('ALTER TABLE funcoes_dirigencia ADD COLUMN tenant_id INT NULL AFTER id');
    await runAlterIgnoreDuplicate('ALTER TABLE funcoes_dirigencia ADD KEY idx_funcoes_dirigencia_tenant (tenant_id)');

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ata_reunioes_pastas (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            nome VARCHAR(120) NOT NULL,
            tipo ENUM('ANO','MES') NOT NULL,
            parent_id INT NULL,
            ordem INT NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_ata_pastas_tenant (tenant_id),
            UNIQUE KEY uniq_ata_pasta_tenant_nome_parent (tenant_id, nome, parent_id),
            CONSTRAINT fk_ata_pasta_parent FOREIGN KEY (parent_id) REFERENCES ata_reunioes_pastas(id) ON DELETE CASCADE
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ata_reunioes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            titulo VARCHAR(255) NULL,
            data_reuniao DATE NOT NULL,
            horario TIME NULL,
            pasta_id INT NULL,
            observacoes_gerais TEXT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_ata_reunioes_tenant (tenant_id)
        )
    `);

    if (!(await hasColumn('ata_reunioes_pastas', 'tenant_id'))) {
        await runAlterIgnoreDuplicate('ALTER TABLE ata_reunioes_pastas ADD COLUMN tenant_id INT NULL AFTER id');
    }
    if (!(await hasColumn('ata_reunioes', 'tenant_id'))) {
        await runAlterIgnoreDuplicate('ALTER TABLE ata_reunioes ADD COLUMN tenant_id INT NULL AFTER id');
    }

    await pool.query('UPDATE ata_reunioes_pastas SET tenant_id = 1 WHERE tenant_id IS NULL');
    await pool.query(`
        UPDATE ata_reunioes a
        LEFT JOIN ata_reunioes_pastas p ON p.id = a.pasta_id
        SET a.tenant_id = COALESCE(p.tenant_id, 1)
        WHERE a.tenant_id IS NULL
    `);

    if (await hasIndex('ata_reunioes_pastas', 'uniq_ata_pasta_nome_parent')) {
        await tryDropIndex('ata_reunioes_pastas', 'uniq_ata_pasta_nome_parent');
    }
    if (!(await hasIndex('ata_reunioes_pastas', 'idx_ata_pastas_tenant'))) {
        await runAlterIgnoreDuplicate('ALTER TABLE ata_reunioes_pastas ADD KEY idx_ata_pastas_tenant (tenant_id)');
    }
    if (!(await hasIndex('ata_reunioes_pastas', 'uniq_ata_pasta_tenant_nome_parent'))) {
        await runAlterIgnoreDuplicate('ALTER TABLE ata_reunioes_pastas ADD UNIQUE KEY uniq_ata_pasta_tenant_nome_parent (tenant_id, nome, parent_id)');
    }
    if (!(await hasIndex('ata_reunioes', 'idx_ata_reunioes_tenant'))) {
        await runAlterIgnoreDuplicate('ALTER TABLE ata_reunioes ADD KEY idx_ata_reunioes_tenant (tenant_id)');
    }
    if (await isNullable('ata_reunioes_pastas', 'tenant_id')) {
        await runAlterIgnoreDuplicate('ALTER TABLE ata_reunioes_pastas MODIFY COLUMN tenant_id INT NOT NULL');
    }
    if (await isNullable('ata_reunioes', 'tenant_id')) {
        await runAlterIgnoreDuplicate('ALTER TABLE ata_reunioes MODIFY COLUMN tenant_id INT NOT NULL');
    }

    const comTitulo = await hasColumn('ata_reunioes', 'titulo');
    if (!comTitulo) {
        await pool.query(`ALTER TABLE ata_reunioes ADD COLUMN titulo VARCHAR(255) NULL AFTER id`);
    }

    const comPastaId = await hasColumn('ata_reunioes', 'pasta_id');
    if (!comPastaId) {
        await pool.query(`ALTER TABLE ata_reunioes ADD COLUMN pasta_id INT NULL AFTER horario`);
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ata_reuniao_presencas (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            ata_id INT NOT NULL,
            usuario_id INT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_ata_presencas_tenant (tenant_id),
            UNIQUE KEY uniq_ata_usuario (ata_id, usuario_id),
            CONSTRAINT fk_ata_presenca_ata FOREIGN KEY (ata_id) REFERENCES ata_reunioes(id) ON DELETE CASCADE,
            CONSTRAINT fk_ata_presenca_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ata_reuniao_pautas (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            ata_id INT NOT NULL,
            ordem INT NOT NULL DEFAULT 1,
            titulo VARCHAR(255) NOT NULL,
            decisoes TEXT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_ata_pautas_tenant (tenant_id),
            CONSTRAINT fk_ata_pauta_ata FOREIGN KEY (ata_id) REFERENCES ata_reunioes(id) ON DELETE CASCADE
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ata_reuniao_tarefas (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            ata_id INT NOT NULL,
            pauta_id INT NULL,
            descricao TEXT NOT NULL,
            responsavel_usuario_id INT NULL,
            responsavel_funcao_id INT NULL,
            prazo DATE NULL,
            status ENUM('PENDENTE','CONCLUIDA') NOT NULL DEFAULT 'PENDENTE',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_ata_tarefas_tenant (tenant_id),
            CONSTRAINT fk_ata_tarefa_ata FOREIGN KEY (ata_id) REFERENCES ata_reunioes(id) ON DELETE CASCADE,
            CONSTRAINT fk_ata_tarefa_usuario FOREIGN KEY (responsavel_usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL
        )
    `);

    for (const tableName of ['ata_reuniao_presencas', 'ata_reuniao_pautas', 'ata_reuniao_tarefas']) {
        if (!(await hasColumn(tableName, 'tenant_id'))) {
            await runAlterIgnoreDuplicate(`ALTER TABLE ${tableName} ADD COLUMN tenant_id INT NULL AFTER id`);
        }
    }
    await pool.query(`
        UPDATE ata_reuniao_presencas ap
        JOIN ata_reunioes a ON a.id = ap.ata_id
        SET ap.tenant_id = a.tenant_id
        WHERE ap.tenant_id IS NULL
    `);
    await pool.query(`
        UPDATE ata_reuniao_pautas p
        JOIN ata_reunioes a ON a.id = p.ata_id
        SET p.tenant_id = a.tenant_id
        WHERE p.tenant_id IS NULL
    `);
    await pool.query(`
        UPDATE ata_reuniao_tarefas t
        JOIN ata_reunioes a ON a.id = t.ata_id
        SET t.tenant_id = a.tenant_id
        WHERE t.tenant_id IS NULL
    `);
    await pool.query('UPDATE ata_reuniao_presencas SET tenant_id = 1 WHERE tenant_id IS NULL');
    await pool.query('UPDATE ata_reuniao_pautas SET tenant_id = 1 WHERE tenant_id IS NULL');
    await pool.query('UPDATE ata_reuniao_tarefas SET tenant_id = 1 WHERE tenant_id IS NULL');
    if (!(await hasIndex('ata_reuniao_presencas', 'idx_ata_presencas_tenant'))) {
        await runAlterIgnoreDuplicate('ALTER TABLE ata_reuniao_presencas ADD KEY idx_ata_presencas_tenant (tenant_id)');
    }
    if (!(await hasIndex('ata_reuniao_pautas', 'idx_ata_pautas_tenant'))) {
        await runAlterIgnoreDuplicate('ALTER TABLE ata_reuniao_pautas ADD KEY idx_ata_pautas_tenant (tenant_id)');
    }
    if (!(await hasIndex('ata_reuniao_tarefas', 'idx_ata_tarefas_tenant'))) {
        await runAlterIgnoreDuplicate('ALTER TABLE ata_reuniao_tarefas ADD KEY idx_ata_tarefas_tenant (tenant_id)');
    }
    for (const t of ['ata_reuniao_presencas', 'ata_reuniao_pautas', 'ata_reuniao_tarefas']) {
        if (await isNullable(t, 'tenant_id')) {
            await runAlterIgnoreDuplicate(`ALTER TABLE \`${t}\` MODIFY COLUMN tenant_id INT NOT NULL`);
        }
    }

    if (!(await hasColumn('ata_reuniao_tarefas', 'pauta_id'))) {
        await pool.query(`ALTER TABLE ata_reuniao_tarefas ADD COLUMN pauta_id INT NULL AFTER ata_id`);
    }
    if (!(await hasColumn('ata_reuniao_tarefas', 'responsavel_funcao_id'))) {
        await pool.query(`ALTER TABLE ata_reuniao_tarefas ADD COLUMN responsavel_funcao_id INT NULL AFTER responsavel_usuario_id`);
    }
}

async function garantirEstrutura() {
    if (!garantirEstruturaPromise) {
        garantirEstruturaPromise = _doGarantirEstrutura().catch(err => {
            console.error('[ataReunioes] Falha em garantirEstrutura:', err.message || err);
            garantirEstruturaPromise = null;
            throw err;
        });
    }
    return garantirEstruturaPromise;
}

function normalizarData(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'string') {
        const txt = value.trim();
        if (!txt) return null;
        if (/^\d{4}-\d{2}-\d{2}$/.test(txt)) return txt;
    }
    return null;
}

function normalizarHorario(value) {
    if (value === null || value === undefined || value === '') return null;
    const txt = String(value).trim();
    if (!txt) return null;
    if (/^\d{2}:\d{2}$/.test(txt)) return `${txt}:00`;
    if (/^\d{2}:\d{2}:\d{2}$/.test(txt)) return txt;
    return null;
}

function toIntArray(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(v => Number(v)).filter(v => Number.isInteger(v) && v > 0))];
}

router.get('/pastas', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    try {
        await garantirEstrutura();
        if (String(req.query.all || '') === '1') {
            const [rows] = await pool.query(
                `SELECT id, nome, tipo, parent_id, ordem, created_at
                 FROM ata_reunioes_pastas
                 WHERE tenant_id = ?
                 ORDER BY parent_id IS NOT NULL ASC, parent_id ASC, ordem ASC, nome ASC`,
                [tenantId]
            );
            return res.json(rows);
        }

        const parentRaw = req.query.parent_id || req.query.parentId || null;
        const parentId = parentRaw ? Number(parentRaw) : null;
        if (parentRaw && !parentId) return res.status(400).json({ error: 'parent_id inválido.' });
        const [rows] = await pool.query(
            `SELECT id, nome, tipo, parent_id, ordem, created_at
             FROM ata_reunioes_pastas
             WHERE tenant_id = ? AND ${parentId ? 'parent_id = ?' : 'parent_id IS NULL'}
             ORDER BY ordem ASC, nome ASC`,
            parentId ? [tenantId, parentId] : [tenantId]
        );
        res.json(rows);
    } catch (err) {
        console.error('Erro ao listar pastas de ata:', err);
        res.status(500).json({ error: 'Erro ao listar pastas' });
    }
});

router.delete('/pastas/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    try {
        await garantirEstrutura();
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ error: 'ID inválido.' });

        const [[pasta]] = await pool.query(
            `SELECT id, tipo FROM ata_reunioes_pastas WHERE id = ? AND tenant_id = ? LIMIT 1`,
            [id, tenantId]
        );
        if (!pasta) return res.status(404).json({ error: 'Pasta não encontrada.' });

        const [filhas] = await pool.query(
            `SELECT id FROM ata_reunioes_pastas WHERE parent_id = ? AND tenant_id = ? LIMIT 1`,
            [id, tenantId]
        );
        if (filhas.length) {
            return res.status(409).json({ error: 'Esta pasta possui subpastas. Remova-as primeiro.' });
        }

        const [atas] = await pool.query(
            `SELECT id FROM ata_reunioes WHERE pasta_id = ? AND tenant_id = ? LIMIT 1`,
            [id, tenantId]
        );
        if (atas.length) {
            return res.status(409).json({ error: 'Esta pasta possui atas. Remova-as primeiro.' });
        }

        await pool.query(`DELETE FROM ata_reunioes_pastas WHERE id = ? AND tenant_id = ?`, [id, tenantId]);
        res.json({ message: 'Pasta removida com sucesso.' });
    } catch (err) {
        console.error('Erro ao remover pasta de ata:', err);
        res.status(500).json({ error: 'Erro ao remover pasta' });
    }
});

router.post('/pastas', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    try {
        await garantirEstrutura();
        const nome = String(req.body.nome || '').trim();
        const parentId = req.body.parent_id ? Number(req.body.parent_id) : null;
        const tipo = parentId ? 'MES' : 'ANO';
        if (!nome) return res.status(400).json({ error: 'Nome da pasta é obrigatório.' });
        if (req.body.parent_id && !parentId) return res.status(400).json({ error: 'Pasta pai inválida.' });

        if (parentId) {
            const [[parent]] = await pool.query(
                `SELECT id, tipo FROM ata_reunioes_pastas WHERE id = ? AND tenant_id = ? LIMIT 1`,
                [parentId, tenantId]
            );
            if (!parent) return res.status(404).json({ error: 'Pasta pai não encontrada.' });
        }

        const [exists] = await pool.query(
            `SELECT id FROM ata_reunioes_pastas WHERE tenant_id = ? AND nome = ? AND ${parentId ? 'parent_id = ?' : 'parent_id IS NULL'} LIMIT 1`,
            parentId ? [tenantId, nome, parentId] : [tenantId, nome]
        );
        if (exists.length) return res.status(409).json({ error: 'Já existe uma pasta com esse nome neste nível.' });

        const [result] = await pool.query(
            `INSERT INTO ata_reunioes_pastas (tenant_id, nome, tipo, parent_id) VALUES (?, ?, ?, ?)`,
            [tenantId, nome, tipo, parentId]
        );
        res.status(201).json({ id: result.insertId, message: 'Pasta criada com sucesso.' });
    } catch (err) {
        console.error('Erro ao criar pasta de ata:', err);
        res.status(500).json({ error: 'Erro ao criar pasta' });
    }
});

router.get('/usuarios', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });
    try {
        await garantirEstrutura();
        const [rows] = await pool.query(`
            SELECT id, nome_completo, username, grupo, data_saida
            FROM usuarios
            WHERE tenant_id = ?
            ORDER BY nome_completo ASC
        `, [tenantId]);
        res.json(rows);
    } catch (err) {
        console.error('Erro ao listar usuários para ata:', err);
        res.status(500).json({ error: 'Erro ao listar usuários' });
    }
});

router.get('/atas', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    try {
        await garantirEstrutura();
        const pastaId = req.query.pasta_id ? Number(req.query.pasta_id) : null;
        if (req.query.pasta_id && !pastaId) return res.status(400).json({ error: 'pasta_id inválido.' });
        const [atas] = await pool.query(`
            SELECT id, titulo, data_reuniao, horario, pasta_id, observacoes_gerais, created_at
            FROM ata_reunioes
            WHERE tenant_id = ? ${pastaId ? 'AND pasta_id = ?' : ''}
            ORDER BY data_reuniao DESC, horario DESC, id DESC
        `, pastaId ? [tenantId, pastaId] : [tenantId]);

        if (!atas.length) return res.json([]);

        const ids = atas.map(a => a.id);
        const [presencas] = await pool.query(`
            SELECT ap.ata_id, ap.usuario_id, u.nome_completo, u.username, u.grupo
            FROM ata_reuniao_presencas ap
            JOIN usuarios u ON u.id = ap.usuario_id AND u.tenant_id = ap.tenant_id
            WHERE ap.tenant_id = ? AND ap.ata_id IN (?)
            ORDER BY u.nome_completo ASC
        `, [tenantId, ids]);

        const [pautas] = await pool.query(`
            SELECT id, ata_id, ordem, titulo, decisoes
            FROM ata_reuniao_pautas
            WHERE tenant_id = ? AND ata_id IN (?)
            ORDER BY ordem ASC, id ASC
        `, [tenantId, ids]);

        const [tarefas] = await pool.query(`
            SELECT t.id, t.ata_id, t.pauta_id, t.descricao, t.responsavel_usuario_id, t.responsavel_funcao_id, t.prazo, t.status,
                   u.nome_completo AS responsavel_usuario_nome,
                   fd.nome AS responsavel_funcao_nome,
                   COALESCE(u.nome_completo, fd.nome) AS responsavel_nome,
                   CASE
                     WHEN t.responsavel_funcao_id IS NOT NULL THEN 'FUNCAO'
                     WHEN t.responsavel_usuario_id IS NOT NULL THEN 'USUARIO'
                     ELSE NULL
                   END AS responsavel_tipo
            FROM ata_reuniao_tarefas t
            LEFT JOIN usuarios u ON u.id = t.responsavel_usuario_id AND u.tenant_id = t.tenant_id
            LEFT JOIN funcoes_dirigencia fd ON fd.id = t.responsavel_funcao_id AND fd.tenant_id = t.tenant_id
            WHERE t.tenant_id = ? AND t.ata_id IN (?)
            ORDER BY t.id ASC
        `, [tenantId, ids]);

        const presencasMap = {};
        presencas.forEach(p => {
            if (!presencasMap[p.ata_id]) presencasMap[p.ata_id] = [];
            presencasMap[p.ata_id].push(p);
        });

        const pautasMap = {};
        const pautasById = {};
        pautas.forEach(p => {
            if (!pautasMap[p.ata_id]) pautasMap[p.ata_id] = [];
            p.tarefas = [];
            pautasMap[p.ata_id].push(p);
            pautasById[p.id] = p;
        });

        const tarefasMap = {};
        tarefas.forEach(t => {
            if (!tarefasMap[t.ata_id]) tarefasMap[t.ata_id] = [];
            tarefasMap[t.ata_id].push(t);
            if (t.pauta_id && pautasById[t.pauta_id]) {
                pautasById[t.pauta_id].tarefas.push(t);
            }
        });

        const result = atas.map(ata => ({
            ...ata,
            presencas: presencasMap[ata.id] || [],
            pautas: pautasMap[ata.id] || [],
            tarefas: tarefasMap[ata.id] || []
        }));

        res.json(result);
    } catch (err) {
        console.error('Erro ao listar atas:', err);
        res.status(500).json({ error: 'Erro ao listar atas' });
    }
});

router.get('/atas/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    try {
        await garantirEstrutura();
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ error: 'ID inválido.' });

        const [atas] = await pool.query(`
            SELECT id, titulo, data_reuniao, horario, pasta_id, observacoes_gerais, created_at
            FROM ata_reunioes
            WHERE id = ? AND tenant_id = ?
            LIMIT 1
        `, [id, tenantId]);

        if (!atas.length) return res.status(404).json({ error: 'Ata não encontrada.' });
        const ata = atas[0];

        const [presencas] = await pool.query(`
            SELECT ap.ata_id, ap.usuario_id, u.nome_completo, u.username, u.grupo
            FROM ata_reuniao_presencas ap
            JOIN usuarios u ON u.id = ap.usuario_id AND u.tenant_id = ap.tenant_id
            WHERE ap.ata_id = ? AND ap.tenant_id = ?
            ORDER BY u.nome_completo ASC
        `, [id, tenantId]);

        const [pautas] = await pool.query(`
            SELECT id, ata_id, ordem, titulo, decisoes
            FROM ata_reuniao_pautas
            WHERE ata_id = ? AND tenant_id = ?
            ORDER BY ordem ASC, id ASC
        `, [id, tenantId]);

        const [tarefas] = await pool.query(`
            SELECT t.id, t.ata_id, t.pauta_id, t.descricao, t.responsavel_usuario_id, t.responsavel_funcao_id, t.prazo, t.status,
                   u.nome_completo AS responsavel_usuario_nome,
                   fd.nome AS responsavel_funcao_nome,
                   COALESCE(u.nome_completo, fd.nome) AS responsavel_nome,
                   CASE
                     WHEN t.responsavel_funcao_id IS NOT NULL THEN 'FUNCAO'
                     WHEN t.responsavel_usuario_id IS NOT NULL THEN 'USUARIO'
                     ELSE NULL
                   END AS responsavel_tipo
            FROM ata_reuniao_tarefas t
            LEFT JOIN usuarios u ON u.id = t.responsavel_usuario_id AND u.tenant_id = t.tenant_id
            LEFT JOIN funcoes_dirigencia fd ON fd.id = t.responsavel_funcao_id AND fd.tenant_id = t.tenant_id
            WHERE t.ata_id = ? AND t.tenant_id = ?
            ORDER BY t.id ASC
        `, [id, tenantId]);

        const pautasById = {};
        pautas.forEach(p => {
            p.tarefas = [];
            pautasById[p.id] = p;
        });
        tarefas.forEach(t => {
            if (t.pauta_id && pautasById[t.pauta_id]) pautasById[t.pauta_id].tarefas.push(t);
        });

        res.json({
            ...ata,
            presencas,
            pautas,
            tarefas
        });
    } catch (err) {
        console.error('Erro ao buscar ata:', err);
        res.status(500).json({ error: 'Erro ao buscar ata' });
    }
});

router.get('/busca', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    try {
        await garantirEstrutura();
        const q = String(req.query.q || '').trim();
        if (!q) return res.json([]);

        const like = `%${q}%`;
        const [rows] = await pool.query(`
            SELECT 
                a.id,
                a.titulo,
                a.data_reuniao,
                a.horario,
                a.observacoes_gerais,
                COALESCE(
                    MAX(CASE WHEN p.titulo LIKE ? THEN CONCAT('Pauta: ', p.titulo) END),
                    MAX(CASE WHEN p.decisoes LIKE ? THEN CONCAT('Decisão: ', p.decisoes) END),
                    MAX(CASE WHEN t.descricao LIKE ? THEN CONCAT('Tarefa: ', t.descricao) END),
                    MAX(CASE WHEN a.observacoes_gerais LIKE ? THEN CONCAT('Obs: ', a.observacoes_gerais) END)
                ) AS trecho
            FROM ata_reunioes a
            LEFT JOIN ata_reuniao_pautas p ON p.ata_id = a.id AND p.tenant_id = a.tenant_id
            LEFT JOIN ata_reuniao_tarefas t ON t.ata_id = a.id AND t.tenant_id = a.tenant_id
            WHERE 
                a.tenant_id = ?
                AND (
                    a.observacoes_gerais LIKE ?
                    OR p.titulo LIKE ?
                    OR p.decisoes LIKE ?
                    OR t.descricao LIKE ?
                )
            GROUP BY a.id, a.titulo, a.data_reuniao, a.horario, a.observacoes_gerais
            ORDER BY a.data_reuniao DESC, a.horario DESC, a.id DESC
            LIMIT 100
        `, [like, like, like, like, tenantId, like, like, like, like]);

        res.json(rows);
    } catch (err) {
        console.error('Erro ao buscar atas por palavra-chave:', err);
        res.status(500).json({ error: 'Erro ao buscar atas' });
    }
});

router.get('/tarefas', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    try {
        await garantirEstrutura();
        const [rows] = await pool.query(`
            SELECT 
                t.id,
                t.ata_id,
                t.pauta_id,
                t.descricao,
                t.responsavel_usuario_id,
                t.responsavel_funcao_id,
                t.prazo,
                t.status,
                a.data_reuniao,
                a.horario,
                p.ordem AS pauta_ordem,
                p.titulo AS pauta_titulo,
                u.nome_completo AS responsavel_usuario_nome,
                fd.nome AS responsavel_funcao_nome,
                COALESCE(u.nome_completo, fd.nome) AS responsavel_nome,
                CASE
                    WHEN t.responsavel_funcao_id IS NOT NULL THEN 'FUNCAO'
                    WHEN t.responsavel_usuario_id IS NOT NULL THEN 'USUARIO'
                    ELSE NULL
                END AS responsavel_tipo
            FROM ata_reuniao_tarefas t
            JOIN ata_reunioes a ON a.id = t.ata_id AND a.tenant_id = t.tenant_id
            LEFT JOIN ata_reuniao_pautas p ON p.id = t.pauta_id AND p.tenant_id = t.tenant_id
            LEFT JOIN usuarios u ON u.id = t.responsavel_usuario_id AND u.tenant_id = t.tenant_id
            LEFT JOIN funcoes_dirigencia fd ON fd.id = t.responsavel_funcao_id AND fd.tenant_id = t.tenant_id
            WHERE t.tenant_id = ?
            ORDER BY 
                CASE WHEN t.status = 'PENDENTE' THEN 0 ELSE 1 END ASC,
                (t.prazo IS NULL) ASC,
                t.prazo ASC,
                a.data_reuniao DESC,
                t.id DESC
        `, [tenantId]);
        res.json(rows);
    } catch (err) {
        console.error('Erro ao listar tarefas das atas:', err);
        res.status(500).json({ error: 'Erro ao listar tarefas' });
    }
});

router.put('/tarefas/:id/status', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    const id = Number(req.params.id);
    const status = String(req.body.status || '').trim().toUpperCase();
    if (!id) return res.status(400).json({ error: 'ID inválido.' });
    if (!['PENDENTE', 'CONCLUIDA'].includes(status)) {
        return res.status(400).json({ error: 'Status inválido.' });
    }

    try {
        await garantirEstrutura();
        const [result] = await pool.query(
            `UPDATE ata_reuniao_tarefas SET status = ? WHERE id = ? AND tenant_id = ?`,
            [status, id, tenantId]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Tarefa não encontrada.' });
        res.json({ message: 'Status da tarefa atualizado com sucesso.' });
    } catch (err) {
        console.error('Erro ao atualizar status da tarefa:', err);
        res.status(500).json({ error: 'Erro ao atualizar status da tarefa' });
    }
});

router.post('/atas', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    const titulo = String(req.body.titulo || '').trim() || null;
    const hoje = new Date();
    const dataReuniao = normalizarData(req.body.data_reuniao) || `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
    const horario = normalizarHorario(req.body.horario);
    const pastaId = req.body.pasta_id ? Number(req.body.pasta_id) : null;
    const observacoesGerais = String(req.body.observacoes_gerais || '').trim() || null;
    const presencas = toIntArray(req.body.presencas);
    const pautas = Array.isArray(req.body.pautas) ? req.body.pautas : [];

    if (!pastaId) return res.status(400).json({ error: 'Selecione uma pasta para salvar a ata.' });
    if (!pautas.length) return res.status(400).json({ error: 'Adicione ao menos uma pauta.' });

    const pautasValidas = pautas
        .map((p, idx) => ({
            ordem: Number.isInteger(Number(p.ordem)) ? Number(p.ordem) : (idx + 1),
            titulo: String(p.titulo || '').trim(),
            decisoes: String(p.decisoes || '').trim() || null,
            tarefas: Array.isArray(p.tarefas) ? p.tarefas : []
        }))
        .filter(p => p.titulo);

    if (!pautasValidas.length) return res.status(400).json({ error: 'Adicione ao menos uma pauta com título.' });

    const connection = await pool.getConnection();
    try {
        await garantirEstrutura();
        await connection.beginTransaction();

        const [[pasta]] = await connection.query(
            `SELECT id, tipo FROM ata_reunioes_pastas WHERE id = ? AND tenant_id = ? LIMIT 1`,
            [pastaId, tenantId]
        );
        if (!pasta) {
            await connection.rollback();
            return res.status(400).json({ error: 'Ata deve ser salva dentro de uma pasta existente.' });
        }

        const [ataResult] = await connection.query(
            `INSERT INTO ata_reunioes (tenant_id, titulo, data_reuniao, horario, pasta_id, observacoes_gerais)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [tenantId, titulo, dataReuniao, horario, pastaId, observacoesGerais]
        );
        const ataId = ataResult.insertId;

        for (const usuarioId of presencas) {
            const [[usuario]] = await connection.query(
                `SELECT id FROM usuarios WHERE id = ? AND tenant_id = ? LIMIT 1`,
                [usuarioId, tenantId]
            );
            if (!usuario) {
                await connection.rollback();
                return res.status(400).json({ error: 'Há presença vinculada a usuário de outro tenant.' });
            }
            await connection.query(
                `INSERT INTO ata_reuniao_presencas (tenant_id, ata_id, usuario_id) VALUES (?, ?, ?)`,
                [tenantId, ataId, usuarioId]
            );
        }

        for (const pauta of pautasValidas) {
            const [pautaResult] = await connection.query(
                `INSERT INTO ata_reuniao_pautas (tenant_id, ata_id, ordem, titulo, decisoes) VALUES (?, ?, ?, ?, ?)`,
                [tenantId, ataId, pauta.ordem, pauta.titulo, pauta.decisoes]
            );
            const pautaId = pautaResult.insertId;
            const tarefasValidasDaPauta = pauta.tarefas
                .map(t => ({
                    descricao: String(t.descricao || '').trim(),
                    responsavel_tipo: String(t.responsavel_tipo || 'USUARIO').trim().toUpperCase(),
                    responsavel_usuario_id: t.responsavel_usuario_id ? Number(t.responsavel_usuario_id) : null,
                    responsavel_funcao_id: t.responsavel_funcao_id ? Number(t.responsavel_funcao_id) : null,
                    prazo: normalizarData(t.prazo),
                    status: String(t.status || '').toUpperCase() === 'CONCLUIDA' ? 'CONCLUIDA' : 'PENDENTE'
                }))
                .filter(t => t.descricao);

            for (const tarefa of tarefasValidasDaPauta) {
                const usuarioId = tarefa.responsavel_tipo === 'USUARIO' ? (tarefa.responsavel_usuario_id || null) : null;
                const funcaoId = tarefa.responsavel_tipo === 'FUNCAO' ? (tarefa.responsavel_funcao_id || null) : null;
                if (usuarioId) {
                    const [[usuario]] = await connection.query(
                        `SELECT id FROM usuarios WHERE id = ? AND tenant_id = ? LIMIT 1`,
                        [usuarioId, tenantId]
                    );
                    if (!usuario) {
                        await connection.rollback();
                        return res.status(400).json({ error: 'Há tarefa vinculada a usuário de outro tenant.' });
                    }
                }
                if (funcaoId) {
                    const [[funcao]] = await connection.query(
                        `SELECT id FROM funcoes_dirigencia WHERE id = ? AND tenant_id = ? LIMIT 1`,
                        [funcaoId, tenantId]
                    );
                    if (!funcao) {
                        await connection.rollback();
                        return res.status(400).json({ error: 'Há tarefa vinculada a função de outro tenant.' });
                    }
                }
                await connection.query(
                    `INSERT INTO ata_reuniao_tarefas (tenant_id, ata_id, pauta_id, descricao, responsavel_usuario_id, responsavel_funcao_id, prazo, status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [tenantId, ataId, pautaId, tarefa.descricao, usuarioId, funcaoId, tarefa.prazo, tarefa.status]
                );
            }
        }

        await connection.commit();
        res.status(201).json({ id: ataId, message: 'Ata criada com sucesso.' });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao criar ata:', err);
        res.status(500).json({ error: 'Erro ao criar ata' });
    } finally {
        connection.release();
    }
});

router.put('/atas/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    const ataId = Number(req.params.id);
    const titulo = String(req.body.titulo || '').trim() || null;
    const dataReuniaoInformada = normalizarData(req.body.data_reuniao);
    const horario = normalizarHorario(req.body.horario);
    const pastaId = req.body.pasta_id ? Number(req.body.pasta_id) : null;
    const observacoesGerais = String(req.body.observacoes_gerais || '').trim() || null;
    const presencas = toIntArray(req.body.presencas);
    const pautas = Array.isArray(req.body.pautas) ? req.body.pautas : [];

    if (!ataId) return res.status(400).json({ error: 'ID inválido.' });
    if (!pastaId) return res.status(400).json({ error: 'Selecione uma pasta para salvar a ata.' });
    if (!pautas.length) return res.status(400).json({ error: 'Adicione ao menos uma pauta.' });

    const pautasValidas = pautas
        .map((p, idx) => ({
            ordem: Number.isInteger(Number(p.ordem)) ? Number(p.ordem) : (idx + 1),
            titulo: String(p.titulo || '').trim(),
            decisoes: String(p.decisoes || '').trim() || null,
            tarefas: Array.isArray(p.tarefas) ? p.tarefas : []
        }))
        .filter(p => p.titulo);

    if (!pautasValidas.length) return res.status(400).json({ error: 'Adicione ao menos uma pauta com título.' });

    const connection = await pool.getConnection();
    try {
        await garantirEstrutura();
        await connection.beginTransaction();

        const [[ataExistente]] = await connection.query(
            `SELECT id, pasta_id, data_reuniao FROM ata_reunioes WHERE id = ? AND tenant_id = ? LIMIT 1`,
            [ataId, tenantId]
        );
        if (!ataExistente) {
            await connection.rollback();
            return res.status(404).json({ error: 'Ata não encontrada.' });
        }
        const dataReuniao = dataReuniaoInformada || (
            ataExistente.data_reuniao ? String(ataExistente.data_reuniao).substring(0, 10) : null
        );
        if (!dataReuniao) {
            await connection.rollback();
            return res.status(400).json({ error: 'Informe a data da ata.' });
        }

        const [[pasta]] = await connection.query(
            `SELECT id, tipo FROM ata_reunioes_pastas WHERE id = ? AND tenant_id = ? LIMIT 1`,
            [pastaId, tenantId]
        );
        if (!pasta) {
            await connection.rollback();
            return res.status(400).json({ error: 'Ata deve ser salva dentro de uma pasta existente.' });
        }

        await connection.query(
            `UPDATE ata_reunioes
             SET titulo = ?, data_reuniao = ?, horario = ?, pasta_id = ?, observacoes_gerais = ?
             WHERE id = ? AND tenant_id = ?`,
            [titulo, dataReuniao, horario, pastaId, observacoesGerais, ataId, tenantId]
        );

        await connection.query(`DELETE FROM ata_reuniao_presencas WHERE ata_id = ? AND tenant_id = ?`, [ataId, tenantId]);
        await connection.query(`DELETE FROM ata_reuniao_tarefas WHERE ata_id = ? AND tenant_id = ?`, [ataId, tenantId]);
        await connection.query(`DELETE FROM ata_reuniao_pautas WHERE ata_id = ? AND tenant_id = ?`, [ataId, tenantId]);

        for (const usuarioId of presencas) {
            const [[usuario]] = await connection.query(
                `SELECT id FROM usuarios WHERE id = ? AND tenant_id = ? LIMIT 1`,
                [usuarioId, tenantId]
            );
            if (!usuario) {
                await connection.rollback();
                return res.status(400).json({ error: 'Há presença vinculada a usuário de outro tenant.' });
            }
            await connection.query(
                `INSERT INTO ata_reuniao_presencas (tenant_id, ata_id, usuario_id) VALUES (?, ?, ?)`,
                [tenantId, ataId, usuarioId]
            );
        }

        for (const pauta of pautasValidas) {
            const [pautaResult] = await connection.query(
                `INSERT INTO ata_reuniao_pautas (tenant_id, ata_id, ordem, titulo, decisoes) VALUES (?, ?, ?, ?, ?)`,
                [tenantId, ataId, pauta.ordem, pauta.titulo, pauta.decisoes]
            );
            const pautaId = pautaResult.insertId;
            const tarefasValidasDaPauta = pauta.tarefas
                .map(t => ({
                    descricao: String(t.descricao || '').trim(),
                    responsavel_tipo: String(t.responsavel_tipo || 'USUARIO').trim().toUpperCase(),
                    responsavel_usuario_id: t.responsavel_usuario_id ? Number(t.responsavel_usuario_id) : null,
                    responsavel_funcao_id: t.responsavel_funcao_id ? Number(t.responsavel_funcao_id) : null,
                    prazo: normalizarData(t.prazo),
                    status: String(t.status || '').toUpperCase() === 'CONCLUIDA' ? 'CONCLUIDA' : 'PENDENTE'
                }))
                .filter(t => t.descricao);

            for (const tarefa of tarefasValidasDaPauta) {
                const usuarioId = tarefa.responsavel_tipo === 'USUARIO' ? (tarefa.responsavel_usuario_id || null) : null;
                const funcaoId = tarefa.responsavel_tipo === 'FUNCAO' ? (tarefa.responsavel_funcao_id || null) : null;
                if (usuarioId) {
                    const [[usuario]] = await connection.query(
                        `SELECT id FROM usuarios WHERE id = ? AND tenant_id = ? LIMIT 1`,
                        [usuarioId, tenantId]
                    );
                    if (!usuario) {
                        await connection.rollback();
                        return res.status(400).json({ error: 'Há tarefa vinculada a usuário de outro tenant.' });
                    }
                }
                if (funcaoId) {
                    const [[funcao]] = await connection.query(
                        `SELECT id FROM funcoes_dirigencia WHERE id = ? AND tenant_id = ? LIMIT 1`,
                        [funcaoId, tenantId]
                    );
                    if (!funcao) {
                        await connection.rollback();
                        return res.status(400).json({ error: 'Há tarefa vinculada a função de outro tenant.' });
                    }
                }
                await connection.query(
                    `INSERT INTO ata_reuniao_tarefas (tenant_id, ata_id, pauta_id, descricao, responsavel_usuario_id, responsavel_funcao_id, prazo, status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [tenantId, ataId, pautaId, tarefa.descricao, usuarioId, funcaoId, tarefa.prazo, tarefa.status]
                );
            }
        }

        await connection.commit();
        res.json({ id: ataId, message: 'Ata atualizada com sucesso.' });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao atualizar ata:', err);
        res.status(500).json({ error: 'Erro ao atualizar ata' });
    } finally {
        connection.release();
    }
});

router.put('/atas/:id/mover', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    const ataId = Number(req.params.id);
    const pastaId = req.body.pasta_id ? Number(req.body.pasta_id) : null;
    if (!ataId) return res.status(400).json({ error: 'ID inválido.' });
    if (!pastaId) return res.status(400).json({ error: 'Pasta de destino inválida.' });

    try {
        await garantirEstrutura();

        const [[ata]] = await pool.query(
            `SELECT id, pasta_id FROM ata_reunioes WHERE id = ? AND tenant_id = ? LIMIT 1`,
            [ataId, tenantId]
        );
        if (!ata) return res.status(404).json({ error: 'Ata não encontrada.' });

        const [[pasta]] = await pool.query(
            `SELECT id FROM ata_reunioes_pastas WHERE id = ? AND tenant_id = ? LIMIT 1`,
            [pastaId, tenantId]
        );
        if (!pasta) return res.status(404).json({ error: 'Pasta de destino não encontrada.' });

        await pool.query(
            `UPDATE ata_reunioes SET pasta_id = ? WHERE id = ? AND tenant_id = ?`,
            [pastaId, ataId, tenantId]
        );

        res.json({ id: ataId, pasta_id: pastaId, message: 'Ata movida com sucesso.' });
    } catch (err) {
        console.error('Erro ao mover ata:', err);
        res.status(500).json({ error: 'Erro ao mover ata' });
    }
});

router.delete('/atas/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });

    try {
        await garantirEstrutura();
        const [result] = await pool.query('DELETE FROM ata_reunioes WHERE id = ? AND tenant_id = ?', [id, tenantId]);
        if (!result.affectedRows) return res.status(404).json({ error: 'Ata não encontrada.' });
        res.json({ message: 'Ata removida com sucesso.' });
    } catch (err) {
        console.error('Erro ao remover ata:', err);
        res.status(500).json({ error: 'Erro ao remover ata' });
    }
});

module.exports = router;
