const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { getTenantId } = require('../lib/tenantIsolation');

let garantirEstruturaPromise = null;

async function _doGarantirEstrutura() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS documentos (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            titulo VARCHAR(255) NOT NULL,
            descricao TEXT,
            ativo BOOLEAN DEFAULT TRUE,
            ordem INT DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_documentos_tenant (tenant_id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS documento_capitulos (
            id INT AUTO_INCREMENT PRIMARY KEY,
            documento_id INT NOT NULL,
            numero INT NOT NULL,
            titulo VARCHAR(255) NOT NULL,
            descricao TEXT,
            ordem INT DEFAULT 0,
            KEY idx_doc_cap_documento (documento_id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS documento_secoes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            capitulo_id INT NOT NULL,
            titulo VARCHAR(255) NOT NULL,
            descricao TEXT,
            ordem INT DEFAULT 0,
            KEY idx_doc_sec_capitulo (capitulo_id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS documento_topicos (
            id INT AUTO_INCREMENT PRIMARY KEY,
            secao_id INT NOT NULL,
            titulo VARCHAR(255) NOT NULL,
            conteudo LONGTEXT,
            ordem INT DEFAULT 0,
            pagina_ref INT,
            tem_subtopicos BOOLEAN DEFAULT FALSE,
            KEY idx_doc_top_secao (secao_id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS documento_subtopicos (
            id INT AUTO_INCREMENT PRIMARY KEY,
            topico_id INT NOT NULL,
            titulo VARCHAR(255) NOT NULL,
            conteudo LONGTEXT,
            ordem INT DEFAULT 0,
            pagina_ref INT,
            KEY idx_doc_sub_topico (topico_id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS documento_progresso (
            id INT AUTO_INCREMENT PRIMARY KEY,
            usuario_id INT NOT NULL,
            tenant_id INT NOT NULL,
            topico_id INT NULL,
            subtopico_id INT NULL,
            status ENUM('nao_lido','lendo','lido') DEFAULT 'nao_lido',
            lido_em TIMESTAMP NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_doc_prog_usuario_tenant (usuario_id, tenant_id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS documento_destaques (
            id INT AUTO_INCREMENT PRIMARY KEY,
            usuario_id INT NOT NULL,
            tenant_id INT NOT NULL,
            topico_id INT NULL,
            subtopico_id INT NULL,
            texto_destacado TEXT NOT NULL,
            nota TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_doc_dest_usuario_tenant (usuario_id, tenant_id)
        )
    `);
}

async function garantirEstrutura() {
    if (!garantirEstruturaPromise) {
        garantirEstruturaPromise = _doGarantirEstrutura().catch(err => {
            console.error('[documentos] Falha em garantirEstrutura:', err.message || err);
            garantirEstruturaPromise = null;
            throw err;
        });
    }
    return garantirEstruturaPromise;
}

// GET /progresso - progresso do usuário logado
router.get('/progresso', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    const usuarioId = req.user && req.user.id;
    if (!usuarioId) return res.status(401).json({ error: 'Usuário não identificado.' });

    try {
        await garantirEstrutura();
        const [rows] = await pool.query(
            `SELECT id, topico_id, subtopico_id, status, lido_em
             FROM documento_progresso
             WHERE usuario_id = ? AND tenant_id = ?`,
            [usuarioId, tenantId]
        );
        res.json(rows);
    } catch (err) {
        console.error('Erro ao listar progresso:', err);
        res.status(500).json({ error: 'Erro ao listar progresso.' });
    }
});

// POST /progresso - marcar tópico/subtópico como lendo ou lido
router.post('/progresso', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    const usuarioId = req.user && req.user.id;
    if (!usuarioId) return res.status(401).json({ error: 'Usuário não identificado.' });

    const topicoId = req.body.topico_id ? Number(req.body.topico_id) : null;
    const subtopId = req.body.subtopico_id ? Number(req.body.subtopico_id) : null;
    const status = String(req.body.status || '').trim();

    if (!topicoId) return res.status(400).json({ error: 'topico_id é obrigatório.' });
    if (!['lendo', 'lido', 'nao_lido'].includes(status)) {
        return res.status(400).json({ error: 'Status inválido. Use: lendo, lido ou nao_lido.' });
    }

    try {
        await garantirEstrutura();

        const lidoEm = status === 'lido' ? new Date() : null;

        // SELECT antes do INSERT/UPDATE porque UNIQUE KEY com NULL não funciona como esperado no MySQL
        let existing;
        if (subtopId) {
            const [[row]] = await pool.query(
                `SELECT id FROM documento_progresso
                 WHERE usuario_id = ? AND tenant_id = ? AND topico_id = ? AND subtopico_id = ?
                 LIMIT 1`,
                [usuarioId, tenantId, topicoId, subtopId]
            );
            existing = row;
        } else {
            const [[row]] = await pool.query(
                `SELECT id FROM documento_progresso
                 WHERE usuario_id = ? AND tenant_id = ? AND topico_id = ? AND subtopico_id IS NULL
                 LIMIT 1`,
                [usuarioId, tenantId, topicoId]
            );
            existing = row;
        }

        if (existing) {
            await pool.query(
                `UPDATE documento_progresso SET status = ?, lido_em = ?, updated_at = NOW() WHERE id = ?`,
                [status, lidoEm, existing.id]
            );
            return res.json({ id: existing.id, status, message: 'Progresso atualizado.' });
        }

        const [result] = await pool.query(
            `INSERT INTO documento_progresso (usuario_id, tenant_id, topico_id, subtopico_id, status, lido_em)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [usuarioId, tenantId, topicoId, subtopId, status, lidoEm]
        );
        res.status(201).json({ id: result.insertId, status, message: 'Progresso registrado.' });
    } catch (err) {
        console.error('Erro ao salvar progresso:', err);
        res.status(500).json({ error: 'Erro ao salvar progresso.' });
    }
});

// GET /destaques - destaques do usuário logado
router.get('/destaques', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    const usuarioId = req.user && req.user.id;
    if (!usuarioId) return res.status(401).json({ error: 'Usuário não identificado.' });

    const topicoId = req.query.topico_id ? Number(req.query.topico_id) : null;
    const subtopId = req.query.subtopico_id ? Number(req.query.subtopico_id) : null;

    try {
        await garantirEstrutura();

        let query = `SELECT id, topico_id, subtopico_id, texto_destacado, nota, created_at
                     FROM documento_destaques
                     WHERE usuario_id = ? AND tenant_id = ?`;
        const params = [usuarioId, tenantId];

        if (topicoId) { query += ' AND topico_id = ?'; params.push(topicoId); }
        if (subtopId) { query += ' AND subtopico_id = ?'; params.push(subtopId); }
        query += ' ORDER BY created_at ASC';

        const [rows] = await pool.query(query, params);
        res.json(rows);
    } catch (err) {
        console.error('Erro ao listar destaques:', err);
        res.status(500).json({ error: 'Erro ao listar destaques.' });
    }
});

// POST /destaques - adicionar destaque em um trecho
router.post('/destaques', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    const usuarioId = req.user && req.user.id;
    if (!usuarioId) return res.status(401).json({ error: 'Usuário não identificado.' });

    const topicoId = req.body.topico_id ? Number(req.body.topico_id) : null;
    const subtopId = req.body.subtopico_id ? Number(req.body.subtopico_id) : null;
    const textoDestacado = String(req.body.texto_destacado || '').trim();
    const nota = String(req.body.nota || '').trim() || null;

    if (!topicoId) return res.status(400).json({ error: 'topico_id é obrigatório.' });
    if (!textoDestacado) return res.status(400).json({ error: 'texto_destacado é obrigatório.' });
    if (textoDestacado.length > 2000) return res.status(400).json({ error: 'Texto destacado muito longo.' });

    try {
        await garantirEstrutura();
        const [result] = await pool.query(
            `INSERT INTO documento_destaques (usuario_id, tenant_id, topico_id, subtopico_id, texto_destacado, nota)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [usuarioId, tenantId, topicoId, subtopId, textoDestacado, nota]
        );
        res.status(201).json({ id: result.insertId, message: 'Destaque adicionado.' });
    } catch (err) {
        console.error('Erro ao adicionar destaque:', err);
        res.status(500).json({ error: 'Erro ao adicionar destaque.' });
    }
});

// DELETE /destaques/:id - remover destaque
router.delete('/destaques/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    const usuarioId = req.user && req.user.id;
    if (!usuarioId) return res.status(401).json({ error: 'Usuário não identificado.' });

    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });

    try {
        await garantirEstrutura();
        const [result] = await pool.query(
            `DELETE FROM documento_destaques WHERE id = ? AND usuario_id = ? AND tenant_id = ?`,
            [id, usuarioId, tenantId]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Destaque não encontrado.' });
        res.json({ message: 'Destaque removido.' });
    } catch (err) {
        console.error('Erro ao remover destaque:', err);
        res.status(500).json({ error: 'Erro ao remover destaque.' });
    }
});

// GET /secoes/:secaoId/topicos - lista tópicos da seção com subtópicos
router.get('/secoes/:secaoId/topicos', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    const secaoId = Number(req.params.secaoId);
    if (!secaoId) return res.status(400).json({ error: 'ID inválido.' });

    try {
        await garantirEstrutura();

        const [[sec]] = await pool.query(`
            SELECT ds.id
            FROM documento_secoes ds
            JOIN documento_capitulos dc ON dc.id = ds.capitulo_id
            JOIN documentos d ON d.id = dc.documento_id
            WHERE ds.id = ? AND d.tenant_id = ? AND d.ativo = TRUE
            LIMIT 1
        `, [secaoId, tenantId]);
        if (!sec) return res.status(404).json({ error: 'Seção não encontrada.' });

        const [topicos] = await pool.query(
            `SELECT id, titulo, conteudo, ordem, pagina_ref, tem_subtopicos
             FROM documento_topicos
             WHERE secao_id = ?
             ORDER BY ordem ASC, id ASC`,
            [secaoId]
        );

        if (!topicos.length) return res.json([]);

        const topicoIds = topicos.map(t => t.id);
        const [subtopicos] = await pool.query(
            `SELECT id, topico_id, titulo, conteudo, ordem, pagina_ref
             FROM documento_subtopicos
             WHERE topico_id IN (?)
             ORDER BY ordem ASC, id ASC`,
            [topicoIds]
        );

        const subMap = {};
        subtopicos.forEach(s => {
            if (!subMap[s.topico_id]) subMap[s.topico_id] = [];
            subMap[s.topico_id].push(s);
        });

        res.json(topicos.map(t => ({ ...t, subtopicos: subMap[t.id] || [] })));
    } catch (err) {
        console.error('Erro ao listar tópicos:', err);
        res.status(500).json({ error: 'Erro ao listar tópicos.' });
    }
});

// GET /topicos/:topicoId - tópico individual com subtópicos (para tela de leitura)
router.get('/topicos/:topicoId', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    const topicoId = Number(req.params.topicoId);
    if (!topicoId) return res.status(400).json({ error: 'ID inválido.' });

    try {
        await garantirEstrutura();

        const [[topico]] = await pool.query(`
            SELECT dt.id, dt.titulo, dt.conteudo, dt.ordem, dt.pagina_ref, dt.tem_subtopicos,
                   ds.id AS secao_id, ds.titulo AS secao_titulo,
                   dc.id AS capitulo_id, dc.numero AS capitulo_numero, dc.titulo AS capitulo_titulo,
                   d.id AS documento_id, d.titulo AS documento_titulo
            FROM documento_topicos dt
            JOIN documento_secoes ds ON ds.id = dt.secao_id
            JOIN documento_capitulos dc ON dc.id = ds.capitulo_id
            JOIN documentos d ON d.id = dc.documento_id
            WHERE dt.id = ? AND d.tenant_id = ? AND d.ativo = TRUE
            LIMIT 1
        `, [topicoId, tenantId]);

        if (!topico) return res.status(404).json({ error: 'Tópico não encontrado.' });

        const [subtopicos] = await pool.query(
            `SELECT id, titulo, conteudo, ordem, pagina_ref
             FROM documento_subtopicos
             WHERE topico_id = ?
             ORDER BY ordem ASC, id ASC`,
            [topicoId]
        );

        res.json({ ...topico, subtopicos });
    } catch (err) {
        console.error('Erro ao buscar tópico:', err);
        res.status(500).json({ error: 'Erro ao buscar tópico.' });
    }
});

// GET /:id/navegacao - lista plana ordenada para navegação (tela de leitura)
router.get('/:id/navegacao', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });

    try {
        await garantirEstrutura();

        const [[doc]] = await pool.query(
            `SELECT id FROM documentos WHERE id = ? AND tenant_id = ? AND ativo = TRUE LIMIT 1`,
            [id, tenantId]
        );
        if (!doc) return res.status(404).json({ error: 'Documento não encontrado.' });

        const [topicos] = await pool.query(`
            SELECT dt.id, dt.titulo, dt.ordem AS topico_ordem, dt.tem_subtopicos,
                   ds.id AS secao_id, ds.titulo AS secao_titulo, ds.ordem AS secao_ordem,
                   dc.id AS capitulo_id, dc.numero AS capitulo_numero, dc.titulo AS capitulo_titulo, dc.ordem AS capitulo_ordem
            FROM documento_topicos dt
            JOIN documento_secoes ds ON ds.id = dt.secao_id
            JOIN documento_capitulos dc ON dc.id = ds.capitulo_id
            WHERE dc.documento_id = ?
            ORDER BY dc.ordem ASC, dc.numero ASC, ds.ordem ASC, dt.ordem ASC, dt.id ASC
        `, [id]);

        if (!topicos.length) return res.json([]);

        const topicoIds = topicos.map(t => t.id);
        const [subtopicos] = await pool.query(
            `SELECT id, topico_id, titulo, ordem
             FROM documento_subtopicos
             WHERE topico_id IN (?)
             ORDER BY ordem ASC, id ASC`,
            [topicoIds]
        );

        const subMap = {};
        subtopicos.forEach(s => {
            if (!subMap[s.topico_id]) subMap[s.topico_id] = [];
            subMap[s.topico_id].push(s);
        });

        const nav = [];
        topicos.forEach(t => {
            const subs = subMap[t.id] || [];
            if (t.tem_subtopicos && subs.length) {
                nav.push({ tipo: 'topico_cabecalho', id: t.id, titulo: t.titulo, secao_id: t.secao_id, capitulo_id: t.capitulo_id });
                subs.forEach(s => nav.push({
                    tipo: 'subtopico', id: s.id, titulo: s.titulo,
                    topico_id: t.id, secao_id: t.secao_id, capitulo_id: t.capitulo_id
                }));
            } else {
                nav.push({ tipo: 'topico', id: t.id, titulo: t.titulo, secao_id: t.secao_id, capitulo_id: t.capitulo_id });
            }
        });

        res.json(nav);
    } catch (err) {
        console.error('Erro ao montar navegação:', err);
        res.status(500).json({ error: 'Erro ao montar navegação.' });
    }
});

// GET / - lista documentos ativos do tenant
router.get('/', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    try {
        await garantirEstrutura();
        const [rows] = await pool.query(
            `SELECT id, titulo, descricao, ordem, created_at
             FROM documentos
             WHERE tenant_id = ? AND ativo = TRUE
             ORDER BY ordem ASC, id ASC`,
            [tenantId]
        );
        res.json(rows);
    } catch (err) {
        console.error('Erro ao listar documentos:', err);
        res.status(500).json({ error: 'Erro ao listar documentos.' });
    }
});

// GET /:id/capitulos - lista capítulos do documento
router.get('/:id/capitulos', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });

    try {
        await garantirEstrutura();
        const [[doc]] = await pool.query(
            `SELECT id FROM documentos WHERE id = ? AND tenant_id = ? AND ativo = TRUE LIMIT 1`,
            [id, tenantId]
        );
        if (!doc) return res.status(404).json({ error: 'Documento não encontrado.' });

        const [rows] = await pool.query(
            `SELECT id, numero, titulo, descricao, ordem
             FROM documento_capitulos
             WHERE documento_id = ?
             ORDER BY ordem ASC, numero ASC, id ASC`,
            [id]
        );
        res.json(rows);
    } catch (err) {
        console.error('Erro ao listar capítulos:', err);
        res.status(500).json({ error: 'Erro ao listar capítulos.' });
    }
});

// GET /:id/capitulos/:capId/secoes - lista seções do capítulo
router.get('/:id/capitulos/:capId/secoes', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    const id = Number(req.params.id);
    const capId = Number(req.params.capId);
    if (!id || !capId) return res.status(400).json({ error: 'ID inválido.' });

    try {
        await garantirEstrutura();
        const [[doc]] = await pool.query(
            `SELECT id FROM documentos WHERE id = ? AND tenant_id = ? AND ativo = TRUE LIMIT 1`,
            [id, tenantId]
        );
        if (!doc) return res.status(404).json({ error: 'Documento não encontrado.' });

        const [[cap]] = await pool.query(
            `SELECT id FROM documento_capitulos WHERE id = ? AND documento_id = ? LIMIT 1`,
            [capId, id]
        );
        if (!cap) return res.status(404).json({ error: 'Capítulo não encontrado.' });

        const [rows] = await pool.query(
            `SELECT id, titulo, descricao, ordem
             FROM documento_secoes
             WHERE capitulo_id = ?
             ORDER BY ordem ASC, id ASC`,
            [capId]
        );
        res.json(rows);
    } catch (err) {
        console.error('Erro ao listar seções:', err);
        res.status(500).json({ error: 'Erro ao listar seções.' });
    }
});

module.exports = router;
