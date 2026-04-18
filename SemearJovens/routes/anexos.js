const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
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

async function garantirEstrutura() {
    if (estruturaGarantida) return;

    await ensureTenantIsolation();

    await pool.query(`
        CREATE TABLE IF NOT EXISTS pastas (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            nome VARCHAR(255) NOT NULL,
            parent_id INT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_pastas_tenant (tenant_id),
            KEY idx_pastas_parent (parent_id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS arquivos (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            nome VARCHAR(255) NOT NULL,
            caminho VARCHAR(255) NOT NULL,
            mimetype VARCHAR(100) NULL,
            tamanho INT NULL,
            pasta_id INT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_arquivos_tenant (tenant_id),
            KEY idx_arquivos_pasta (pasta_id)
        )
    `);

    if (!(await hasColumn('pastas', 'tenant_id'))) {
        await pool.query('ALTER TABLE pastas ADD COLUMN tenant_id INT NULL AFTER id');
    }
    if (!(await hasColumn('arquivos', 'tenant_id'))) {
        await pool.query('ALTER TABLE arquivos ADD COLUMN tenant_id INT NULL AFTER id');
    }

    await pool.query('UPDATE pastas SET tenant_id = 1 WHERE tenant_id IS NULL');
    await pool.query(`
        UPDATE arquivos a
        JOIN pastas p ON p.id = a.pasta_id
        SET a.tenant_id = p.tenant_id
        WHERE a.tenant_id IS NULL
    `);
    await pool.query('UPDATE arquivos SET tenant_id = 1 WHERE tenant_id IS NULL');

    await pool.query('ALTER TABLE pastas MODIFY tenant_id INT NOT NULL');
    await pool.query('ALTER TABLE arquivos MODIFY tenant_id INT NOT NULL');

    estruturaGarantida = true;
}

function createUpload(tenantId) {
    const storage = multer.diskStorage({
        destination: function (_req, _file, cb) {
            const uploadDir = path.join('public', 'uploads', `tenant-${tenantId}`, 'anexos');
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }
            cb(null, uploadDir);
        },
        filename: function (_req, file, cb) {
            const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
            cb(null, `${uniqueSuffix}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`);
        }
    });
    return multer({ storage });
}

router.get('/pastas', async (req, res) => {
    const tenantId = getTenantId(req);
    const parentId = req.query.parentId || null;
    try {
        await garantirEstrutura();
        const query = parentId
            ? 'SELECT * FROM pastas WHERE tenant_id = ? AND parent_id = ?'
            : 'SELECT * FROM pastas WHERE tenant_id = ? AND parent_id IS NULL';
        const params = parentId ? [tenantId, parentId] : [tenantId];
        const [rows] = await pool.query(query, params);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao listar pastas' });
    }
});

router.post('/pastas', async (req, res) => {
    const tenantId = getTenantId(req);
    const { nome, parentId } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });
    try {
        await garantirEstrutura();
        if (parentId) {
            const [parentRows] = await pool.query(
                'SELECT id FROM pastas WHERE id = ? AND tenant_id = ? LIMIT 1',
                [parentId, tenantId]
            );
            if (!parentRows.length) return res.status(404).json({ error: 'Pasta pai não encontrada.' });
        }
        const [result] = await pool.query(
            'INSERT INTO pastas (tenant_id, nome, parent_id) VALUES (?, ?, ?)',
            [tenantId, nome, parentId || null]
        );
        res.json({ id: result.insertId, nome, parentId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao criar pasta' });
    }
});

async function deleteFolderContents(tenantId, folderId) {
    const [subfolders] = await pool.query(
        'SELECT id FROM pastas WHERE tenant_id = ? AND parent_id = ?',
        [tenantId, folderId]
    );

    for (const subfolder of subfolders) {
        await deleteFolderContents(tenantId, subfolder.id);
    }

    const [files] = await pool.query(
        'SELECT caminho FROM arquivos WHERE tenant_id = ? AND pasta_id = ?',
        [tenantId, folderId]
    );

    for (const file of files) {
        if (fs.existsSync(file.caminho)) {
            try {
                fs.unlinkSync(file.caminho);
            } catch (e) {
                console.error(`Erro ao deletar arquivo físico: ${file.caminho}`, e);
            }
        }
    }
}

router.delete('/pastas/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    const folderId = Number(req.params.id);
    if (!folderId) return res.status(400).json({ error: 'ID inválido.' });
    try {
        await garantirEstrutura();
        await deleteFolderContents(tenantId, folderId);
        await pool.query('DELETE FROM arquivos WHERE tenant_id = ? AND pasta_id = ?', [tenantId, folderId]);
        await pool.query('DELETE FROM pastas WHERE id = ? AND tenant_id = ?', [folderId, tenantId]);
        res.json({ message: 'Pasta e conteúdo deletados' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao deletar pasta' });
    }
});

router.get('/arquivos', async (req, res) => {
    const tenantId = getTenantId(req);
    const pastaId = req.query.pastaId || null;
    try {
        await garantirEstrutura();
        const query = pastaId
            ? 'SELECT * FROM arquivos WHERE tenant_id = ? AND pasta_id = ?'
            : 'SELECT * FROM arquivos WHERE tenant_id = ? AND pasta_id IS NULL';
        const params = pastaId ? [tenantId, pastaId] : [tenantId];
        const [rows] = await pool.query(query, params);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao listar arquivos' });
    }
});

router.post('/upload', async (req, res) => {
    const tenantId = getTenantId(req);
    try {
        await garantirEstrutura();
        const upload = createUpload(tenantId).single('arquivo');
        upload(req, res, async (err) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ error: 'Erro ao enviar arquivo' });
            }
            if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

            const { pastaId } = req.body;
            if (pastaId) {
                const [pastaRows] = await pool.query(
                    'SELECT id FROM pastas WHERE id = ? AND tenant_id = ? LIMIT 1',
                    [pastaId, tenantId]
                );
                if (!pastaRows.length) return res.status(404).json({ error: 'Pasta não encontrada.' });
            }

            const [result] = await pool.query(
                'INSERT INTO arquivos (tenant_id, nome, caminho, mimetype, tamanho, pasta_id) VALUES (?, ?, ?, ?, ?, ?)',
                [tenantId, req.file.originalname, req.file.path, req.file.mimetype, req.file.size, pastaId || null]
            );
            return res.json({ id: result.insertId, nome: req.file.originalname });
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao salvar arquivo no banco' });
    }
});

router.delete('/arquivos/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    const arquivoId = Number(req.params.id);
    if (!arquivoId) return res.status(400).json({ error: 'ID inválido.' });

    try {
        await garantirEstrutura();
        const [rows] = await pool.query(
            'SELECT caminho FROM arquivos WHERE id = ? AND tenant_id = ?',
            [arquivoId, tenantId]
        );
        if (rows.length > 0) {
            const caminho = rows[0].caminho;
            if (fs.existsSync(caminho)) {
                fs.unlinkSync(caminho);
            }
        }
        await pool.query('DELETE FROM arquivos WHERE id = ? AND tenant_id = ?', [arquivoId, tenantId]);
        res.json({ message: 'Arquivo deletado' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao deletar arquivo' });
    }
});

module.exports = router;
