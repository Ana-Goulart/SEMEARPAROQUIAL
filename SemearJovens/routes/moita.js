const express = require('express');
const router = express.Router();
const { pool } = require('../database');

let estruturaGarantida = false;

function getTenantId(req) {
    return Number(req.user?.tenant_id || 0);
}

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

    await pool.query(`
        CREATE TABLE IF NOT EXISTS moita_funcoes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            nome VARCHAR(120) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_moita_funcoes_tenant (tenant_id),
            UNIQUE KEY uniq_moita_funcoes_tenant_nome (tenant_id, nome)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS moita_reservas (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            jovem_id INT NOT NULL,
            lista ENUM('MULHERES','HOMENS') NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_moita_reservas_tenant (tenant_id),
            UNIQUE KEY uniq_moita_reserva_tenant_jovem (tenant_id, jovem_id),
            CONSTRAINT fk_moita_reserva_jovem FOREIGN KEY (jovem_id) REFERENCES jovens(id) ON DELETE CASCADE
        )
    `);

    if (!(await hasColumn('moita_funcoes', 'tenant_id'))) {
        await pool.query('ALTER TABLE moita_funcoes ADD COLUMN tenant_id INT NULL AFTER id');
    }
    if (!(await hasColumn('moita_reservas', 'tenant_id'))) {
        await pool.query('ALTER TABLE moita_reservas ADD COLUMN tenant_id INT NULL AFTER id');
    }

    await pool.query('UPDATE moita_funcoes SET tenant_id = 1 WHERE tenant_id IS NULL');
    await pool.query(`
        UPDATE moita_reservas mr
        JOIN jovens j ON j.id = mr.jovem_id
        SET mr.tenant_id = j.tenant_id
        WHERE mr.tenant_id IS NULL
    `);
    await pool.query('UPDATE moita_reservas SET tenant_id = 1 WHERE tenant_id IS NULL');

    if (await hasIndex('moita_funcoes', 'nome')) {
        await pool.query('ALTER TABLE moita_funcoes DROP INDEX nome');
    }
    if (!(await hasIndex('moita_funcoes', 'uniq_moita_funcoes_tenant_nome'))) {
        await pool.query('ALTER TABLE moita_funcoes ADD UNIQUE KEY uniq_moita_funcoes_tenant_nome (tenant_id, nome)');
    }
    if (!(await hasIndex('moita_funcoes', 'idx_moita_funcoes_tenant'))) {
        await pool.query('ALTER TABLE moita_funcoes ADD KEY idx_moita_funcoes_tenant (tenant_id)');
    }

    if (!(await hasIndex('moita_reservas', 'idx_moita_reservas_tenant'))) {
        await pool.query('ALTER TABLE moita_reservas ADD KEY idx_moita_reservas_tenant (tenant_id)');
    }

    estruturaGarantida = true;
}

async function jovemJaFoiMoita(tenantId, jovemId, executor = pool) {
    const [rows] = await executor.query(
        `SELECT id
         FROM jovens_comissoes
         WHERE tenant_id = ?
           AND jovem_id = ?
           AND tipo = 'MOITA_OUTRO'
         LIMIT 1`,
        [tenantId, jovemId]
    );
    return Array.isArray(rows) && rows.length > 0;
}

router.get('/funcoes', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    try {
        await garantirEstrutura();
        const [rows] = await pool.query(
            'SELECT id, nome, created_at FROM moita_funcoes WHERE tenant_id = ? ORDER BY nome ASC',
            [tenantId]
        );
        res.json(rows);
    } catch (err) {
        console.error('Erro ao listar funções de moita:', err);
        res.status(500).json({ error: 'Erro ao listar funções de moita' });
    }
});

router.get('/reservas', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    try {
        await garantirEstrutura();
        const [rows] = await pool.query(`
            SELECT mr.id, mr.jovem_id, mr.lista, mr.created_at,
                   j.nome_completo, j.telefone, j.circulo, j.sexo, j.data_nascimento,
                   j.numero_ejc_fez,
                   eorig.numero AS ejc_origem_numero
            FROM moita_reservas mr
            JOIN jovens j ON j.id = mr.jovem_id AND j.tenant_id = mr.tenant_id
            LEFT JOIN ejc eorig ON eorig.id = j.numero_ejc_fez AND eorig.tenant_id = j.tenant_id
            WHERE mr.tenant_id = ?
            ORDER BY j.nome_completo ASC
        `, [tenantId]);
        res.json({
            mulheres: rows.filter(r => r.lista === 'MULHERES'),
            homens: rows.filter(r => r.lista === 'HOMENS')
        });
    } catch (err) {
        console.error('Erro ao listar reservas de moita:', err);
        res.status(500).json({ error: 'Erro ao listar reservas de moita' });
    }
});

router.post('/reservas', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    const jovemId = Number(req.body.jovem_id);
    const listaRaw = String(req.body.lista || '').trim().toUpperCase();
    const lista = ['MULHERES', 'HOMENS'].includes(listaRaw) ? listaRaw : null;
    if (!jovemId || !lista) return res.status(400).json({ error: 'Dados inválidos.' });

    try {
        await garantirEstrutura();
        const [[jovem]] = await pool.query(
            'SELECT id, sexo FROM jovens WHERE id = ? AND tenant_id = ? LIMIT 1',
            [jovemId, tenantId]
        );
        if (!jovem) return res.status(404).json({ error: 'Jovem não encontrado.' });

        if (jovem.sexo === 'Feminino' && lista !== 'MULHERES') {
            return res.status(409).json({ error: 'Este jovem é do sexo feminino e deve estar na lista de mulheres.' });
        }
        if (jovem.sexo === 'Masculino' && lista !== 'HOMENS') {
            return res.status(409).json({ error: 'Este jovem é do sexo masculino e deve estar na lista de homens.' });
        }

        if (await jovemJaFoiMoita(tenantId, jovemId)) {
            return res.status(409).json({ error: 'Este jovem já foi moita e não pode ser adicionado novamente nem entrar na lista de reserva de moita.' });
        }

        const [exists] = await pool.query(
            'SELECT id FROM moita_reservas WHERE tenant_id = ? AND jovem_id = ? LIMIT 1',
            [tenantId, jovemId]
        );
        if (exists.length) return res.status(409).json({ error: 'Este jovem já está em uma lista de reserva.' });

        const [result] = await pool.query(
            'INSERT INTO moita_reservas (tenant_id, jovem_id, lista) VALUES (?, ?, ?)',
            [tenantId, jovemId, lista]
        );
        res.status(201).json({ id: result.insertId, message: 'Jovem adicionado à reserva de moita.' });
    } catch (err) {
        console.error('Erro ao adicionar jovem na reserva de moita:', err);
        res.status(500).json({ error: 'Erro ao adicionar jovem na reserva de moita' });
    }
});

router.post('/reservas/automatico', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    const jovemId = Number(req.body.jovem_id);
    if (!jovemId) return res.status(400).json({ error: 'Jovem é obrigatório.' });

    try {
        await garantirEstrutura();
        const [[jovem]] = await pool.query(
            'SELECT id, sexo FROM jovens WHERE id = ? AND tenant_id = ? LIMIT 1',
            [jovemId, tenantId]
        );
        if (!jovem) return res.status(404).json({ error: 'Jovem não encontrado.' });

        if (!jovem.sexo) {
            return res.status(409).json({ error: 'Defina o sexo do jovem para adicionar na reserva de moita.' });
        }

        const lista = jovem.sexo === 'Feminino' ? 'MULHERES' : 'HOMENS';
        if (await jovemJaFoiMoita(tenantId, jovemId)) {
            return res.status(409).json({ error: 'Este jovem já foi moita e não pode ser adicionado novamente nem entrar na lista de reserva de moita.' });
        }

        const [exists] = await pool.query(
            'SELECT id FROM moita_reservas WHERE tenant_id = ? AND jovem_id = ? LIMIT 1',
            [tenantId, jovemId]
        );
        if (exists.length) return res.status(409).json({ error: 'Este jovem já está em uma lista de reserva.' });

        const [result] = await pool.query(
            'INSERT INTO moita_reservas (tenant_id, jovem_id, lista) VALUES (?, ?, ?)',
            [tenantId, jovemId, lista]
        );

        res.status(201).json({
            id: result.insertId,
            lista,
            message: 'Jovem adicionado à lista de reserva de moita com sucesso.'
        });
    } catch (err) {
        console.error('Erro ao adicionar jovem automaticamente na reserva de moita:', err);
        res.status(500).json({ error: 'Erro ao adicionar jovem automaticamente na reserva de moita' });
    }
});

router.post('/reservas/:id/titular', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    const reservaId = Number(req.params.id);
    const ejcNumero = Number(req.body.ejc_numero);
    const outroEjcId = Number(req.body.outro_ejc_id);
    const funcaoMoita = String(req.body.funcao_moita || '').trim();

    if (!reservaId || !Number.isInteger(ejcNumero) || ejcNumero <= 0 || !outroEjcId || !funcaoMoita) {
        return res.status(400).json({ error: 'Informe número do EJC, outro EJC e função no moita.' });
    }

    const connection = await pool.getConnection();
    try {
        await garantirEstrutura();
        await connection.beginTransaction();

        const [[reserva]] = await connection.query(
            `SELECT mr.id, mr.jovem_id
             FROM moita_reservas mr
             JOIN jovens j ON j.id = mr.jovem_id AND j.tenant_id = mr.tenant_id
             WHERE mr.id = ? AND mr.tenant_id = ?
             LIMIT 1`,
            [reservaId, tenantId]
        );
        if (!reserva) {
            await connection.rollback();
            return res.status(404).json({ error: 'Reserva não encontrada.' });
        }

        const [outroRows] = await connection.query(
            'SELECT id FROM outros_ejcs WHERE id = ? AND tenant_id = ? LIMIT 1',
            [outroEjcId, tenantId]
        );
        if (!outroRows.length) {
            await connection.rollback();
            return res.status(404).json({ error: 'Outro EJC não encontrado.' });
        }

        if (await jovemJaFoiMoita(tenantId, reserva.jovem_id, connection)) {
            await connection.rollback();
            return res.status(409).json({ error: 'Este jovem já foi moita e não pode ser adicionado novamente.' });
        }

        const [comissaoResult] = await connection.query(
            `INSERT INTO jovens_comissoes
                (tenant_id, jovem_id, tipo, ejc_numero, funcao_garcom, outro_ejc_id)
             VALUES (?, ?, 'MOITA_OUTRO', ?, ?, ?)`,
            [tenantId, reserva.jovem_id, ejcNumero, funcaoMoita, outroEjcId]
        );

        await connection.query(
            'DELETE FROM moita_reservas WHERE id = ? AND tenant_id = ?',
            [reservaId, tenantId]
        );

        await connection.commit();
        return res.status(201).json({
            id: comissaoResult.insertId,
            message: 'Jovem promovido para titular de moita com sucesso.'
        });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao promover jovem da reserva de moita para titular:', err);
        return res.status(500).json({ error: 'Erro ao promover jovem da reserva para moita.' });
    } finally {
        connection.release();
    }
});

router.delete('/reservas/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });

    try {
        await garantirEstrutura();
        const [result] = await pool.query(
            'DELETE FROM moita_reservas WHERE id = ? AND tenant_id = ?',
            [id, tenantId]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Registro não encontrado.' });
        res.json({ message: 'Jovem removido da reserva de moita.' });
    } catch (err) {
        console.error('Erro ao remover jovem da reserva de moita:', err);
        res.status(500).json({ error: 'Erro ao remover jovem da reserva de moita' });
    }
});

router.post('/funcoes', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    const nome = String(req.body.nome || '').trim();
    if (!nome) return res.status(400).json({ error: 'Nome da função é obrigatório.' });

    try {
        await garantirEstrutura();
        const [exists] = await pool.query(
            'SELECT id FROM moita_funcoes WHERE tenant_id = ? AND LOWER(nome)=LOWER(?) LIMIT 1',
            [tenantId, nome]
        );
        if (exists.length) return res.status(409).json({ error: 'Esta função já existe.' });

        const [result] = await pool.query(
            'INSERT INTO moita_funcoes (tenant_id, nome) VALUES (?, ?)',
            [tenantId, nome]
        );
        res.status(201).json({ id: result.insertId, message: 'Função criada com sucesso.' });
    } catch (err) {
        console.error('Erro ao criar função de moita:', err);
        res.status(500).json({ error: 'Erro ao criar função de moita' });
    }
});

router.delete('/funcoes/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });

    try {
        await garantirEstrutura();
        const [result] = await pool.query(
            'DELETE FROM moita_funcoes WHERE id = ? AND tenant_id = ?',
            [id, tenantId]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Função não encontrada.' });
        res.json({ message: 'Função removida com sucesso.' });
    } catch (err) {
        console.error('Erro ao remover função de moita:', err);
        res.status(500).json({ error: 'Erro ao remover função de moita' });
    }
});

router.get('/registros', async (req, res) => {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Tenant não identificado.' });

    try {
        await garantirEstrutura();
        const comParoquiaCol = await hasColumn('jovens_comissoes', 'paroquia');
        const comFuncaoCol = await hasColumn('jovens_comissoes', 'funcao_garcom');
        const selectParoquia = comParoquiaCol
            ? 'COALESCE(oe.paroquia, jc.paroquia) AS paroquia'
            : 'oe.paroquia AS paroquia';
        const selectFuncao = comFuncaoCol
            ? "COALESCE(jc.funcao_garcom, '-') AS funcao_moita"
            : "'-' AS funcao_moita";

        const [rows] = await pool.query(`
            SELECT 
                jc.id,
                jc.jovem_id,
                j.nome_completo,
                j.telefone,
                j.numero_ejc_fez,
                eorig.numero AS ejc_origem_numero,
                jc.ejc_numero,
                ${selectParoquia},
                ${selectFuncao}
            FROM jovens_comissoes jc
            JOIN jovens j ON j.id = jc.jovem_id AND j.tenant_id = jc.tenant_id
            LEFT JOIN ejc eorig ON eorig.id = j.numero_ejc_fez AND eorig.tenant_id = j.tenant_id
            LEFT JOIN outros_ejcs oe ON oe.id = jc.outro_ejc_id
            WHERE jc.tipo = 'MOITA_OUTRO'
              AND jc.tenant_id = ?
            ORDER BY jc.id DESC
        `, [tenantId]);
        res.json(rows);
    } catch (err) {
        console.error('Erro ao listar registros de moita:', err);
        res.status(500).json({ error: 'Erro ao listar registros de moita' });
    }
});

module.exports = router;
