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
        CREATE TABLE IF NOT EXISTS funcoes_dirigencia (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            nome VARCHAR(160) NOT NULL,
            descricao TEXT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_funcoes_dirigencia_tenant (tenant_id),
            UNIQUE KEY uniq_funcoes_dirigencia_tenant_nome (tenant_id, nome)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS funcoes_dirigencia_usuarios (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            funcao_id INT NOT NULL,
            usuario_id INT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_funcao_usuario (funcao_id, usuario_id),
            CONSTRAINT fk_fd_usuario_funcao FOREIGN KEY (funcao_id) REFERENCES funcoes_dirigencia(id) ON DELETE CASCADE,
            CONSTRAINT fk_fd_usuario_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
            KEY idx_fd_usuarios_tenant (tenant_id)
        )
    `);

    if (!(await hasColumn('funcoes_dirigencia', 'tenant_id'))) {
        await pool.query('ALTER TABLE funcoes_dirigencia ADD COLUMN tenant_id INT NULL AFTER id');
    }
    if (!(await hasColumn('funcoes_dirigencia_usuarios', 'tenant_id'))) {
        await pool.query('ALTER TABLE funcoes_dirigencia_usuarios ADD COLUMN tenant_id INT NULL AFTER id');
    }

    await pool.query('UPDATE funcoes_dirigencia SET tenant_id = 1 WHERE tenant_id IS NULL');
    await pool.query(`
        UPDATE funcoes_dirigencia_usuarios fdu
        JOIN funcoes_dirigencia fd ON fd.id = fdu.funcao_id
        SET fdu.tenant_id = fd.tenant_id
        WHERE fdu.tenant_id IS NULL
    `);
    await pool.query('UPDATE funcoes_dirigencia_usuarios SET tenant_id = 1 WHERE tenant_id IS NULL');

    if (await hasIndex('funcoes_dirigencia', 'nome')) {
        await pool.query('ALTER TABLE funcoes_dirigencia DROP INDEX nome');
    }
    if (!(await hasIndex('funcoes_dirigencia', 'uniq_funcoes_dirigencia_tenant_nome'))) {
        await pool.query('ALTER TABLE funcoes_dirigencia ADD UNIQUE KEY uniq_funcoes_dirigencia_tenant_nome (tenant_id, nome)');
    }
    if (!(await hasIndex('funcoes_dirigencia', 'idx_funcoes_dirigencia_tenant'))) {
        await pool.query('ALTER TABLE funcoes_dirigencia ADD KEY idx_funcoes_dirigencia_tenant (tenant_id)');
    }
    if (!(await hasIndex('funcoes_dirigencia_usuarios', 'idx_fd_usuarios_tenant'))) {
        await pool.query('ALTER TABLE funcoes_dirigencia_usuarios ADD KEY idx_fd_usuarios_tenant (tenant_id)');
    }

    await pool.query('ALTER TABLE funcoes_dirigencia MODIFY tenant_id INT NOT NULL');
    await pool.query('ALTER TABLE funcoes_dirigencia_usuarios MODIFY tenant_id INT NOT NULL');

    estruturaGarantida = true;
}

function toIntArray(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(v => Number(v)).filter(v => Number.isInteger(v) && v > 0))];
}

router.get('/', async (req, res) => {
    const tenantId = getTenantId(req);
    try {
        await garantirEstrutura();
        const [funcoes] = await pool.query(`
            SELECT id, nome, descricao, created_at
            FROM funcoes_dirigencia
            WHERE tenant_id = ?
            ORDER BY nome ASC
        `, [tenantId]);

        if (!funcoes.length) return res.json([]);

        const ids = funcoes.map(f => f.id);
        const [vinculos] = await pool.query(`
            SELECT fdu.funcao_id, fdu.usuario_id, u.nome_completo, u.username, u.grupo
            FROM funcoes_dirigencia_usuarios fdu
            JOIN usuarios u ON u.id = fdu.usuario_id AND u.tenant_id = fdu.tenant_id
            WHERE fdu.tenant_id = ?
              AND fdu.funcao_id IN (?)
            ORDER BY u.nome_completo ASC
        `, [tenantId, ids]);

        const usuariosPorFuncao = {};
        vinculos.forEach(v => {
            if (!usuariosPorFuncao[v.funcao_id]) usuariosPorFuncao[v.funcao_id] = [];
            usuariosPorFuncao[v.funcao_id].push(v);
        });

        const result = funcoes.map(f => ({
            ...f,
            usuarios: usuariosPorFuncao[f.id] || []
        }));
        res.json(result);
    } catch (err) {
        console.error('Erro ao listar funções da dirigência:', err);
        res.status(500).json({ error: 'Erro ao listar funções da dirigência' });
    }
});

router.post('/', async (req, res) => {
    const tenantId = getTenantId(req);
    const nome = String(req.body.nome || '').trim();
    const descricao = String(req.body.descricao || '').trim() || null;
    const usuarios = toIntArray(req.body.usuarios);

    if (!nome) return res.status(400).json({ error: 'Nome da função é obrigatório.' });
    if (!usuarios.length) return res.status(400).json({ error: 'Selecione ao menos um usuário.' });

    const connection = await pool.getConnection();
    try {
        await garantirEstrutura();
        await connection.beginTransaction();

        const [exists] = await connection.query(
            `SELECT id FROM funcoes_dirigencia WHERE tenant_id = ? AND LOWER(nome) = LOWER(?) LIMIT 1`,
            [tenantId, nome]
        );
        if (exists.length) {
            await connection.rollback();
            return res.status(409).json({ error: 'Já existe uma função com esse nome.' });
        }

        const [usuariosValidos] = await connection.query(
            'SELECT id FROM usuarios WHERE tenant_id = ? AND id IN (?)',
            [tenantId, usuarios]
        );
        if (usuariosValidos.length !== usuarios.length) {
            await connection.rollback();
            return res.status(400).json({ error: 'Há usuários inválidos para este tenant.' });
        }

        const [result] = await connection.query(
            `INSERT INTO funcoes_dirigencia (tenant_id, nome, descricao) VALUES (?, ?, ?)`,
            [tenantId, nome, descricao]
        );
        const funcaoId = result.insertId;

        for (const usuarioId of usuarios) {
            await connection.query(
                `INSERT INTO funcoes_dirigencia_usuarios (tenant_id, funcao_id, usuario_id) VALUES (?, ?, ?)`,
                [tenantId, funcaoId, usuarioId]
            );
        }

        await connection.commit();
        res.status(201).json({ id: funcaoId, message: 'Função criada com sucesso.' });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao criar função da dirigência:', err);
        res.status(500).json({ error: 'Erro ao criar função da dirigência' });
    } finally {
        connection.release();
    }
});

router.put('/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });

    const nome = String(req.body.nome || '').trim();
    const descricao = String(req.body.descricao || '').trim() || null;
    const usuarios = toIntArray(req.body.usuarios);

    if (!nome) return res.status(400).json({ error: 'Nome da função é obrigatório.' });
    if (!usuarios.length) return res.status(400).json({ error: 'Selecione ao menos um usuário.' });

    const connection = await pool.getConnection();
    try {
        await garantirEstrutura();
        await connection.beginTransaction();

        const [exists] = await connection.query(
            `SELECT id FROM funcoes_dirigencia WHERE tenant_id = ? AND LOWER(nome) = LOWER(?) AND id <> ? LIMIT 1`,
            [tenantId, nome, id]
        );
        if (exists.length) {
            await connection.rollback();
            return res.status(409).json({ error: 'Já existe uma função com esse nome.' });
        }

        const [usuariosValidos] = await connection.query(
            'SELECT id FROM usuarios WHERE tenant_id = ? AND id IN (?)',
            [tenantId, usuarios]
        );
        if (usuariosValidos.length !== usuarios.length) {
            await connection.rollback();
            return res.status(400).json({ error: 'Há usuários inválidos para este tenant.' });
        }

        const [resultUpdate] = await connection.query(
            `UPDATE funcoes_dirigencia SET nome = ?, descricao = ? WHERE id = ? AND tenant_id = ?`,
            [nome, descricao, id, tenantId]
        );
        if (!resultUpdate.affectedRows) {
            await connection.rollback();
            return res.status(404).json({ error: 'Função não encontrada.' });
        }

        await connection.query(
            `DELETE FROM funcoes_dirigencia_usuarios WHERE funcao_id = ? AND tenant_id = ?`,
            [id, tenantId]
        );
        for (const usuarioId of usuarios) {
            await connection.query(
                `INSERT INTO funcoes_dirigencia_usuarios (tenant_id, funcao_id, usuario_id) VALUES (?, ?, ?)`,
                [tenantId, id, usuarioId]
            );
        }

        await connection.commit();
        res.json({ message: 'Função atualizada com sucesso.' });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao atualizar função da dirigência:', err);
        res.status(500).json({ error: 'Erro ao atualizar função da dirigência' });
    } finally {
        connection.release();
    }
});

router.delete('/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });

    try {
        await garantirEstrutura();
        const [result] = await pool.query(
            `DELETE FROM funcoes_dirigencia WHERE id = ? AND tenant_id = ?`,
            [id, tenantId]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Função não encontrada.' });
        res.json({ message: 'Função removida com sucesso.' });
    } catch (err) {
        console.error('Erro ao remover função da dirigência:', err);
        res.status(500).json({ error: 'Erro ao remover função da dirigência' });
    }
});

module.exports = router;
