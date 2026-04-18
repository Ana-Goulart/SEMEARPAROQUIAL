const express = require('express');
const router = express.Router();
const { pool } = require('../database');

let estruturaGarantida = false;
let estruturaPromise = null;

async function garantirEstrutura() {
    if (estruturaGarantida) return;
    if (estruturaPromise) return estruturaPromise;

    estruturaPromise = (async () => {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS almoxarifado_categorias (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tenant_id INT NOT NULL,
                nome VARCHAR(120) NOT NULL,
                descricao VARCHAR(255) NULL,
                ativo TINYINT(1) NOT NULL DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_almox_categoria_tenant_nome (tenant_id, nome),
                KEY idx_almox_categoria_tenant (tenant_id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS almoxarifado_locais (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tenant_id INT NOT NULL,
                nome VARCHAR(120) NOT NULL,
                descricao VARCHAR(255) NULL,
                ativo TINYINT(1) NOT NULL DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_almox_local_tenant_nome (tenant_id, nome),
                KEY idx_almox_local_tenant (tenant_id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS almoxarifado_itens (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tenant_id INT NOT NULL,
                categoria_id INT NULL,
                local_id INT NULL,
                nome VARCHAR(180) NOT NULL,
                descricao TEXT NULL,
                unidade VARCHAR(30) NOT NULL DEFAULT 'UN',
                quantidade_atual DECIMAL(12,2) NOT NULL DEFAULT 0,
                quantidade_minima DECIMAL(12,2) NOT NULL DEFAULT 0,
                localizacao VARCHAR(180) NULL,
                status ENUM('ATIVO','INATIVO') NOT NULL DEFAULT 'ATIVO',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                KEY idx_almox_itens_tenant (tenant_id),
                KEY idx_almox_itens_categoria (categoria_id),
                KEY idx_almox_itens_local (local_id),
                CONSTRAINT fk_almox_itens_categoria
                    FOREIGN KEY (categoria_id) REFERENCES almoxarifado_categorias(id)
                    ON DELETE SET NULL,
                CONSTRAINT fk_almox_itens_local
                    FOREIGN KEY (local_id) REFERENCES almoxarifado_locais(id)
                    ON DELETE SET NULL
            )
        `);

        const [colunasItens] = await pool.query('SHOW COLUMNS FROM almoxarifado_itens');
        const nomesColunasItens = new Set((colunasItens || []).map((c) => String(c.Field || '').toLowerCase()));
        if (!nomesColunasItens.has('local_id')) {
            await pool.query('ALTER TABLE almoxarifado_itens ADD COLUMN local_id INT NULL AFTER categoria_id');
            await pool.query('ALTER TABLE almoxarifado_itens ADD KEY idx_almox_itens_local (local_id)');
        }

        await pool.query(`
            CREATE TABLE IF NOT EXISTS almoxarifado_movimentacoes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tenant_id INT NOT NULL,
                item_id INT NOT NULL,
                tipo ENUM('EMPRESTIMO','DOACAO','DEVOLUCAO') NOT NULL,
                nome_responsavel VARCHAR(180) NOT NULL,
                movimento_pastoral VARCHAR(180) NOT NULL,
                quantidade DECIMAL(12,2) NOT NULL,
                referencia_emprestimo_id INT NULL,
                observacao TEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                KEY idx_almox_mov_tenant (tenant_id),
                KEY idx_almox_mov_item (item_id),
                KEY idx_almox_mov_ref_emprestimo (referencia_emprestimo_id),
                CONSTRAINT fk_almox_mov_item
                    FOREIGN KEY (item_id) REFERENCES almoxarifado_itens(id)
                    ON DELETE CASCADE
            )
        `);

        const [colunasMov] = await pool.query('SHOW COLUMNS FROM almoxarifado_movimentacoes');
        const nomesColunas = new Set((colunasMov || []).map((c) => String(c.Field || '').toLowerCase()));
        if (!nomesColunas.has('referencia_emprestimo_id')) {
            await pool.query('ALTER TABLE almoxarifado_movimentacoes ADD COLUMN referencia_emprestimo_id INT NULL AFTER quantidade');
            await pool.query('ALTER TABLE almoxarifado_movimentacoes ADD KEY idx_almox_mov_ref_emprestimo (referencia_emprestimo_id)');
        }
        const colunaTipo = (colunasMov || []).find((c) => String(c.Field || '').toLowerCase() === 'tipo');
        const tipoDef = String(colunaTipo && colunaTipo.Type ? colunaTipo.Type : '').toUpperCase();
        if (tipoDef && !tipoDef.includes('DEVOLUCAO')) {
            await pool.query("ALTER TABLE almoxarifado_movimentacoes MODIFY COLUMN tipo ENUM('EMPRESTIMO','DOACAO','DEVOLUCAO') NOT NULL");
        }

        estruturaGarantida = true;
    })();

    try {
        await estruturaPromise;
    } finally {
        estruturaPromise = null;
    }
}

function getTenantId(req) {
    return Number(req && req.user && req.user.tenant_id ? req.user.tenant_id : 0);
}

function validarTexto(valor, maxLen) {
    const txt = String(valor || '').trim();
    if (!txt) return '';
    return txt.slice(0, maxLen);
}

function validarTipoMovimentacao(valor) {
    const tipo = validarTexto(valor, 20).toUpperCase();
    if (tipo === 'EMPRESTIMO' || tipo === 'DOACAO' || tipo === 'DEVOLUCAO') return tipo;
    return '';
}

router.get('/resumo', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'Tenant inválido.' });
    try {
        await garantirEstrutura();
        const [[resumo]] = await pool.query(
            `SELECT
                (SELECT COUNT(*) FROM almoxarifado_categorias WHERE tenant_id = ? AND ativo = 1) AS total_categorias,
                (SELECT COUNT(*) FROM almoxarifado_itens WHERE tenant_id = ?) AS total_itens,
                (SELECT COUNT(*) FROM almoxarifado_itens WHERE tenant_id = ? AND quantidade_atual <= quantidade_minima) AS total_baixo_estoque,
                (SELECT COALESCE(SUM(quantidade_atual), 0) FROM almoxarifado_itens WHERE tenant_id = ?) AS total_unidades
            `,
            [tenantId, tenantId, tenantId, tenantId]
        );
        return res.json({
            total_categorias: Number(resumo.total_categorias || 0),
            total_itens: Number(resumo.total_itens || 0),
            total_baixo_estoque: Number(resumo.total_baixo_estoque || 0),
            total_unidades: Number(resumo.total_unidades || 0)
        });
    } catch (err) {
        console.error('Erro ao carregar resumo do almoxarifado:', err);
        return res.status(500).json({ error: 'Erro ao carregar resumo.' });
    }
});

router.get('/categorias', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'Tenant inválido.' });
    try {
        await garantirEstrutura();
        const [rows] = await pool.query(
            `SELECT id, nome, descricao, ativo, created_at, updated_at
             FROM almoxarifado_categorias
             WHERE tenant_id = ?
             ORDER BY ativo DESC, nome ASC`,
            [tenantId]
        );
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar categorias do almoxarifado:', err);
        return res.status(500).json({ error: 'Erro ao listar categorias.' });
    }
});

router.get('/locais', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'Tenant inválido.' });
    try {
        await garantirEstrutura();
        const [rows] = await pool.query(
            `SELECT id, nome, descricao, ativo, created_at, updated_at
             FROM almoxarifado_locais
             WHERE tenant_id = ?
             ORDER BY ativo DESC, nome ASC`,
            [tenantId]
        );
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar locais do almoxarifado:', err);
        return res.status(500).json({ error: 'Erro ao listar locais.' });
    }
});

router.post('/locais', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'Tenant inválido.' });
    const nome = validarTexto(req.body.nome, 120);
    const descricao = validarTexto(req.body.descricao, 255);
    const ativo = req.body.ativo === false ? 0 : 1;
    if (!nome) return res.status(400).json({ error: 'Informe o nome do local.' });
    try {
        await garantirEstrutura();
        const [result] = await pool.query(
            `INSERT INTO almoxarifado_locais (tenant_id, nome, descricao, ativo)
             VALUES (?, ?, ?, ?)`,
            [tenantId, nome, descricao || null, ativo]
        );
        return res.status(201).json({ id: result.insertId, message: 'Local criado com sucesso.' });
    } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Já existe um local com esse nome.' });
        }
        console.error('Erro ao criar local do almoxarifado:', err);
        return res.status(500).json({ error: 'Erro ao criar local.' });
    }
});

router.put('/locais/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.id || 0);
    if (!tenantId || !id) return res.status(400).json({ error: 'Parâmetros inválidos.' });
    const nome = validarTexto(req.body.nome, 120);
    const descricao = validarTexto(req.body.descricao, 255);
    const ativo = req.body.ativo === false ? 0 : 1;
    if (!nome) return res.status(400).json({ error: 'Informe o nome do local.' });
    try {
        await garantirEstrutura();
        const [result] = await pool.query(
            `UPDATE almoxarifado_locais
             SET nome = ?, descricao = ?, ativo = ?
             WHERE id = ? AND tenant_id = ?`,
            [nome, descricao || null, ativo, id, tenantId]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Local não encontrado.' });
        return res.json({ message: 'Local atualizado com sucesso.' });
    } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Já existe um local com esse nome.' });
        }
        console.error('Erro ao atualizar local do almoxarifado:', err);
        return res.status(500).json({ error: 'Erro ao atualizar local.' });
    }
});

router.delete('/locais/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.id || 0);
    if (!tenantId || !id) return res.status(400).json({ error: 'Parâmetros inválidos.' });
    try {
        await garantirEstrutura();
        const [[itens]] = await pool.query(
            'SELECT COUNT(*) AS total FROM almoxarifado_itens WHERE tenant_id = ? AND local_id = ?',
            [tenantId, id]
        );
        if (Number(itens.total || 0) > 0) {
            return res.status(400).json({ error: 'Existem itens vinculados a este local.' });
        }
        const [result] = await pool.query(
            'DELETE FROM almoxarifado_locais WHERE id = ? AND tenant_id = ?',
            [id, tenantId]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Local não encontrado.' });
        return res.json({ message: 'Local removido com sucesso.' });
    } catch (err) {
        console.error('Erro ao excluir local do almoxarifado:', err);
        return res.status(500).json({ error: 'Erro ao excluir local.' });
    }
});

router.post('/categorias', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'Tenant inválido.' });
    const nome = validarTexto(req.body.nome, 120);
    const descricao = validarTexto(req.body.descricao, 255);
    const ativo = req.body.ativo === false ? 0 : 1;
    if (!nome) return res.status(400).json({ error: 'Informe o nome da categoria.' });
    try {
        await garantirEstrutura();
        const [result] = await pool.query(
            `INSERT INTO almoxarifado_categorias (tenant_id, nome, descricao, ativo)
             VALUES (?, ?, ?, ?)`,
            [tenantId, nome, descricao || null, ativo]
        );
        return res.status(201).json({ id: result.insertId, message: 'Categoria criada com sucesso.' });
    } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Já existe uma categoria com esse nome.' });
        }
        console.error('Erro ao criar categoria do almoxarifado:', err);
        return res.status(500).json({ error: 'Erro ao criar categoria.' });
    }
});

router.put('/categorias/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.id || 0);
    if (!tenantId || !id) return res.status(400).json({ error: 'Parâmetros inválidos.' });
    const nome = validarTexto(req.body.nome, 120);
    const descricao = validarTexto(req.body.descricao, 255);
    const ativo = req.body.ativo === false ? 0 : 1;
    if (!nome) return res.status(400).json({ error: 'Informe o nome da categoria.' });
    try {
        await garantirEstrutura();
        const [result] = await pool.query(
            `UPDATE almoxarifado_categorias
             SET nome = ?, descricao = ?, ativo = ?
             WHERE id = ? AND tenant_id = ?`,
            [nome, descricao || null, ativo, id, tenantId]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Categoria não encontrada.' });
        return res.json({ message: 'Categoria atualizada com sucesso.' });
    } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Já existe uma categoria com esse nome.' });
        }
        console.error('Erro ao atualizar categoria do almoxarifado:', err);
        return res.status(500).json({ error: 'Erro ao atualizar categoria.' });
    }
});

router.delete('/categorias/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.id || 0);
    if (!tenantId || !id) return res.status(400).json({ error: 'Parâmetros inválidos.' });
    try {
        await garantirEstrutura();
        const [[itens]] = await pool.query(
            'SELECT COUNT(*) AS total FROM almoxarifado_itens WHERE tenant_id = ? AND categoria_id = ?',
            [tenantId, id]
        );
        if (Number(itens.total || 0) > 0) {
            return res.status(400).json({ error: 'Existem itens vinculados a esta categoria.' });
        }
        const [result] = await pool.query(
            'DELETE FROM almoxarifado_categorias WHERE id = ? AND tenant_id = ?',
            [id, tenantId]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Categoria não encontrada.' });
        return res.json({ message: 'Categoria removida com sucesso.' });
    } catch (err) {
        console.error('Erro ao excluir categoria do almoxarifado:', err);
        return res.status(500).json({ error: 'Erro ao excluir categoria.' });
    }
});

router.get('/itens', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'Tenant inválido.' });
    const q = validarTexto(req.query.q, 120).toLowerCase();
    const categoriaId = Number(req.query.categoria_id || 0);
    const localId = Number(req.query.local_id || 0);
    const status = validarTexto(req.query.status, 10).toUpperCase();
    const baixoEstoque = String(req.query.baixo_estoque || '') === '1';
    try {
        await garantirEstrutura();
        const filtros = ['i.tenant_id = ?'];
        const params = [tenantId];

        if (q) {
            filtros.push('(LOWER(i.nome) LIKE ? OR LOWER(i.localizacao) LIKE ? OR LOWER(i.descricao) LIKE ?)');
            const like = `%${q}%`;
            params.push(like, like, like);
        }
        if (categoriaId) {
            filtros.push('i.categoria_id = ?');
            params.push(categoriaId);
        }
        if (localId) {
            filtros.push('i.local_id = ?');
            params.push(localId);
        }
        if (status === 'ATIVO' || status === 'INATIVO') {
            filtros.push('i.status = ?');
            params.push(status);
        }
        if (baixoEstoque) {
            filtros.push('i.quantidade_atual <= i.quantidade_minima');
        }

        const [rows] = await pool.query(
            `SELECT i.id, i.categoria_id, i.local_id, i.nome, i.descricao, i.unidade, i.quantidade_atual,
                    i.quantidade_minima, i.localizacao, i.status, i.created_at, i.updated_at,
                    c.nome AS categoria_nome,
                    l.nome AS local_nome
             FROM almoxarifado_itens i
             LEFT JOIN almoxarifado_categorias c ON c.id = i.categoria_id AND c.tenant_id = i.tenant_id
             LEFT JOIN almoxarifado_locais l ON l.id = i.local_id AND l.tenant_id = i.tenant_id
             WHERE ${filtros.join(' AND ')}
             ORDER BY i.status DESC, i.nome ASC`,
            params
        );
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar itens do almoxarifado:', err);
        return res.status(500).json({ error: 'Erro ao listar itens.' });
    }
});

router.post('/itens', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'Tenant inválido.' });
    const categoriaId = Number(req.body.categoria_id || 0) || null;
    const localId = Number(req.body.local_id || 0) || null;
    const nome = validarTexto(req.body.nome, 180);
    const descricao = String(req.body.descricao || '').trim() || null;
    const unidade = validarTexto(req.body.unidade, 30).toUpperCase() || 'UN';
    const quantidadeAtual = Number(req.body.quantidade_atual || 0);
    const quantidadeMinima = Number(req.body.quantidade_minima || 0);
    const localizacao = validarTexto(req.body.localizacao, 180) || null;
    const status = validarTexto(req.body.status, 10).toUpperCase() === 'INATIVO' ? 'INATIVO' : 'ATIVO';

    if (!nome) return res.status(400).json({ error: 'Informe o nome do item.' });
    if (!Number.isFinite(quantidadeAtual) || quantidadeAtual < 0) return res.status(400).json({ error: 'Quantidade atual inválida.' });
    if (!Number.isFinite(quantidadeMinima) || quantidadeMinima < 0) return res.status(400).json({ error: 'Quantidade mínima inválida.' });

    try {
        await garantirEstrutura();

        if (categoriaId) {
            const [[cat]] = await pool.query(
                'SELECT id FROM almoxarifado_categorias WHERE id = ? AND tenant_id = ? LIMIT 1',
                [categoriaId, tenantId]
            );
            if (!cat) return res.status(400).json({ error: 'Categoria inválida.' });
        }
        if (localId) {
            const [[local]] = await pool.query(
                'SELECT id FROM almoxarifado_locais WHERE id = ? AND tenant_id = ? LIMIT 1',
                [localId, tenantId]
            );
            if (!local) return res.status(400).json({ error: 'Local inválido.' });
        }

        const [result] = await pool.query(
            `INSERT INTO almoxarifado_itens
                (tenant_id, categoria_id, local_id, nome, descricao, unidade, quantidade_atual, quantidade_minima, localizacao, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [tenantId, categoriaId, localId, nome, descricao, unidade, Number(quantidadeAtual.toFixed(2)), Number(quantidadeMinima.toFixed(2)), localizacao, status]
        );
        return res.status(201).json({ id: result.insertId, message: 'Item cadastrado com sucesso.' });
    } catch (err) {
        console.error('Erro ao criar item de almoxarifado:', err);
        return res.status(500).json({ error: 'Erro ao cadastrar item.' });
    }
});

router.put('/itens/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.id || 0);
    if (!tenantId || !id) return res.status(400).json({ error: 'Parâmetros inválidos.' });
    const categoriaId = Number(req.body.categoria_id || 0) || null;
    const localId = Number(req.body.local_id || 0) || null;
    const nome = validarTexto(req.body.nome, 180);
    const descricao = String(req.body.descricao || '').trim() || null;
    const unidade = validarTexto(req.body.unidade, 30).toUpperCase() || 'UN';
    const quantidadeAtual = Number(req.body.quantidade_atual || 0);
    const quantidadeMinima = Number(req.body.quantidade_minima || 0);
    const localizacao = validarTexto(req.body.localizacao, 180) || null;
    const status = validarTexto(req.body.status, 10).toUpperCase() === 'INATIVO' ? 'INATIVO' : 'ATIVO';

    if (!nome) return res.status(400).json({ error: 'Informe o nome do item.' });
    if (!Number.isFinite(quantidadeAtual) || quantidadeAtual < 0) return res.status(400).json({ error: 'Quantidade atual inválida.' });
    if (!Number.isFinite(quantidadeMinima) || quantidadeMinima < 0) return res.status(400).json({ error: 'Quantidade mínima inválida.' });

    try {
        await garantirEstrutura();

        if (categoriaId) {
            const [[cat]] = await pool.query(
                'SELECT id FROM almoxarifado_categorias WHERE id = ? AND tenant_id = ? LIMIT 1',
                [categoriaId, tenantId]
            );
            if (!cat) return res.status(400).json({ error: 'Categoria inválida.' });
        }
        if (localId) {
            const [[local]] = await pool.query(
                'SELECT id FROM almoxarifado_locais WHERE id = ? AND tenant_id = ? LIMIT 1',
                [localId, tenantId]
            );
            if (!local) return res.status(400).json({ error: 'Local inválido.' });
        }

        const [result] = await pool.query(
            `UPDATE almoxarifado_itens
             SET categoria_id = ?, local_id = ?, nome = ?, descricao = ?, unidade = ?, quantidade_atual = ?, quantidade_minima = ?, localizacao = ?, status = ?
             WHERE id = ? AND tenant_id = ?`,
            [categoriaId, localId, nome, descricao, unidade, Number(quantidadeAtual.toFixed(2)), Number(quantidadeMinima.toFixed(2)), localizacao, status, id, tenantId]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Item não encontrado.' });
        return res.json({ message: 'Item atualizado com sucesso.' });
    } catch (err) {
        console.error('Erro ao atualizar item do almoxarifado:', err);
        return res.status(500).json({ error: 'Erro ao atualizar item.' });
    }
});

router.delete('/itens/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.id || 0);
    if (!tenantId || !id) return res.status(400).json({ error: 'Parâmetros inválidos.' });
    try {
        await garantirEstrutura();
        const [result] = await pool.query(
            'DELETE FROM almoxarifado_itens WHERE id = ? AND tenant_id = ?',
            [id, tenantId]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Item não encontrado.' });
        return res.json({ message: 'Item removido com sucesso.' });
    } catch (err) {
        console.error('Erro ao excluir item do almoxarifado:', err);
        return res.status(500).json({ error: 'Erro ao excluir item.' });
    }
});

router.get('/itens/:id/movimentacoes', async (req, res) => {
    const tenantId = getTenantId(req);
    const itemId = Number(req.params.id || 0);
    if (!tenantId || !itemId) return res.status(400).json({ error: 'Parâmetros inválidos.' });
    try {
        await garantirEstrutura();
        await pool.query(
            `DELETE FROM almoxarifado_movimentacoes
             WHERE tenant_id = ? AND created_at < DATE_SUB(NOW(), INTERVAL 1 YEAR)`,
            [tenantId]
        );
        const [[item]] = await pool.query(
            `SELECT id, nome, unidade, quantidade_atual, quantidade_minima
             FROM almoxarifado_itens
             WHERE id = ? AND tenant_id = ?
             LIMIT 1`,
            [itemId, tenantId]
        );
        if (!item) return res.status(404).json({ error: 'Item não encontrado.' });

        const [movimentacoes] = await pool.query(
            `SELECT id, item_id, tipo, nome_responsavel, movimento_pastoral, quantidade, referencia_emprestimo_id, observacao, created_at
             FROM almoxarifado_movimentacoes
             WHERE tenant_id = ? AND item_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT 100`,
            [tenantId, itemId]
        );

        return res.json({ item, movimentacoes });
    } catch (err) {
        console.error('Erro ao listar movimentações do almoxarifado:', err);
        return res.status(500).json({ error: 'Erro ao listar movimentações.' });
    }
});

router.post('/itens/:id/movimentacoes', async (req, res) => {
    const tenantId = getTenantId(req);
    const itemId = Number(req.params.id || 0);
    if (!tenantId || !itemId) return res.status(400).json({ error: 'Parâmetros inválidos.' });

    const tipo = validarTipoMovimentacao(req.body.tipo);
    let nomeResponsavel = validarTexto(req.body.nome_responsavel, 180);
    let movimentoPastoral = validarTexto(req.body.movimento_pastoral, 180);
    const observacao = String(req.body.observacao || '').trim() || null;
    const quantidade = Number(req.body.quantidade || 0);
    const referenciaEmprestimoId = Number(req.body.referencia_emprestimo_id || 0) || null;

    if (!tipo) return res.status(400).json({ error: 'Tipo de movimentação inválido.' });
    if (!Number.isFinite(quantidade) || quantidade <= 0) return res.status(400).json({ error: 'Quantidade inválida.' });
    if (tipo !== 'DEVOLUCAO') {
        if (!nomeResponsavel) return res.status(400).json({ error: 'Informe o nome de quem está recebendo.' });
        if (!movimentoPastoral) return res.status(400).json({ error: 'Informe o movimento/pastoral.' });
    } else if (!referenciaEmprestimoId) {
        return res.status(400).json({ error: 'Empréstimo de referência inválido para devolução.' });
    }

    let conn;
    try {
        await garantirEstrutura();
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const [[item]] = await conn.query(
            `SELECT id, nome, unidade, quantidade_atual
             FROM almoxarifado_itens
             WHERE id = ? AND tenant_id = ?
             LIMIT 1
             FOR UPDATE`,
            [itemId, tenantId]
        );
        if (!item) {
            await conn.rollback();
            return res.status(404).json({ error: 'Item não encontrado.' });
        }

        const quantidadeAtual = Number(item.quantidade_atual || 0);
        let itemRemovido = false;
        let novaQuantidade = quantidadeAtual;
        let mensagem = 'Movimentação registrada com sucesso.';

        if (tipo === 'DEVOLUCAO') {
            const [[emprestimo]] = await conn.query(
                `SELECT id, nome_responsavel, movimento_pastoral, quantidade
                 FROM almoxarifado_movimentacoes
                 WHERE id = ? AND tenant_id = ? AND item_id = ? AND tipo = 'EMPRESTIMO'
                 LIMIT 1
                 FOR UPDATE`,
                [referenciaEmprestimoId, tenantId, itemId]
            );
            if (!emprestimo) {
                await conn.rollback();
                return res.status(400).json({ error: 'Empréstimo de referência não encontrado.' });
            }

            const [[devolvido]] = await conn.query(
                `SELECT COALESCE(SUM(quantidade), 0) AS total
                 FROM almoxarifado_movimentacoes
                 WHERE tenant_id = ? AND item_id = ? AND tipo = 'DEVOLUCAO' AND referencia_emprestimo_id = ?`,
                [tenantId, itemId, referenciaEmprestimoId]
            );
            const totalEmprestado = Number(emprestimo.quantidade || 0);
            const totalDevolvido = Number(devolvido.total || 0);
            const saldoDisponivel = Number((totalEmprestado - totalDevolvido).toFixed(2));

            if (quantidade > saldoDisponivel) {
                await conn.rollback();
                return res.status(400).json({ error: 'Quantidade de devolução maior que o saldo emprestado.' });
            }

            nomeResponsavel = nomeResponsavel || String(emprestimo.nome_responsavel || '');
            movimentoPastoral = movimentoPastoral || String(emprestimo.movimento_pastoral || '');
            novaQuantidade = Number((quantidadeAtual + quantidade).toFixed(2));

            await conn.query(
                `INSERT INTO almoxarifado_movimentacoes
                    (tenant_id, item_id, tipo, nome_responsavel, movimento_pastoral, quantidade, referencia_emprestimo_id, observacao)
                 VALUES (?, ?, 'DEVOLUCAO', ?, ?, ?, ?, ?)`,
                [tenantId, itemId, nomeResponsavel, movimentoPastoral, Number(quantidade.toFixed(2)), referenciaEmprestimoId, observacao]
            );
            await conn.query(
                `UPDATE almoxarifado_itens
                 SET quantidade_atual = ?
                 WHERE id = ? AND tenant_id = ?`,
                [novaQuantidade, itemId, tenantId]
            );
            mensagem = 'Devolução registrada com sucesso.';
        } else {
            if (quantidade > quantidadeAtual) {
                await conn.rollback();
                return res.status(400).json({ error: 'Quantidade maior que o estoque disponível.' });
            }
            novaQuantidade = Number((quantidadeAtual - quantidade).toFixed(2));
            await conn.query(
                `INSERT INTO almoxarifado_movimentacoes
                    (tenant_id, item_id, tipo, nome_responsavel, movimento_pastoral, quantidade, referencia_emprestimo_id, observacao)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [tenantId, itemId, tipo, nomeResponsavel, movimentoPastoral, Number(quantidade.toFixed(2)), null, observacao]
            );

            if (tipo === 'DOACAO' && novaQuantidade <= 0) {
                await conn.query(
                    'DELETE FROM almoxarifado_itens WHERE id = ? AND tenant_id = ?',
                    [itemId, tenantId]
                );
                itemRemovido = true;
                mensagem = 'Doação registrada e item removido do estoque.';
            } else {
                await conn.query(
                    `UPDATE almoxarifado_itens
                     SET quantidade_atual = ?
                     WHERE id = ? AND tenant_id = ?`,
                    [novaQuantidade, itemId, tenantId]
                );
                mensagem = tipo === 'DOACAO' ? 'Doação registrada com sucesso.' : 'Empréstimo registrado com sucesso.';
            }
        }

        await conn.commit();
        return res.status(201).json({
            message: mensagem,
            item_removido: itemRemovido,
            quantidade_restante: itemRemovido ? 0 : novaQuantidade
        });
    } catch (err) {
        if (conn) await conn.rollback();
        console.error('Erro ao registrar movimentação do almoxarifado:', err);
        return res.status(500).json({ error: 'Erro ao registrar movimentação.' });
    } finally {
        if (conn) conn.release();
    }
});

module.exports = router;
