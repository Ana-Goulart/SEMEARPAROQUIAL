const express = require('express');
const { pool } = require('../database');
const { ensureTenantStructure } = require('../lib/tenantSetup');

const router = express.Router();

let estruturaOk = false;
let estruturaPromise = null;

async function garantirEstrutura() {
    if (estruturaOk) return;
    if (estruturaPromise) {
        await estruturaPromise;
        return;
    }

    estruturaPromise = (async () => {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS meu_ejc_config (
                id TINYINT NOT NULL PRIMARY KEY,
                nome VARCHAR(140) NOT NULL DEFAULT 'Inconfidentes',
                paroquia VARCHAR(180) NULL,
                endereco VARCHAR(255) NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            INSERT INTO meu_ejc_config (id, nome)
            VALUES (1, 'Inconfidentes')
            ON DUPLICATE KEY UPDATE nome = COALESCE(nome, 'Inconfidentes')
        `);

        try {
            await pool.query('ALTER TABLE meu_ejc_config ADD COLUMN paroquia VARCHAR(180) NULL AFTER nome');
        } catch (e) {
            if (!e || e.code !== 'ER_DUP_FIELDNAME') throw e;
        }
        try {
            await pool.query('ALTER TABLE meu_ejc_config ADD COLUMN endereco VARCHAR(255) NULL AFTER paroquia');
        } catch (e) {
            if (!e || e.code !== 'ER_DUP_FIELDNAME') throw e;
        }
        try {
            await pool.query('ALTER TABLE meu_ejc_config ADD COLUMN estado_atende VARCHAR(120) NULL AFTER endereco');
        } catch (e) {
            if (!e || e.code !== 'ER_DUP_FIELDNAME') throw e;
        }
        try {
            await pool.query('ALTER TABLE meu_ejc_config ADD COLUMN cidade_atende VARCHAR(120) NULL AFTER estado_atende');
        } catch (e) {
            if (!e || e.code !== 'ER_DUP_FIELDNAME') throw e;
        }
        try {
            await pool.query('ALTER TABLE meu_ejc_config ADD COLUMN bairros_atendidos LONGTEXT NULL AFTER cidade_atende');
        } catch (e) {
            if (!e || e.code !== 'ER_DUP_FIELDNAME') throw e;
        }

        estruturaOk = true;
    })();

    try {
        await estruturaPromise;
    } finally {
        estruturaPromise = null;
    }
}

router.get('/', async (_req, res) => {
    try {
        await ensureTenantStructure();
        await garantirEstrutura();
        const tenantId = _req.user && _req.user.tenant_id ? Number(_req.user.tenant_id) : 0;
        if (tenantId) {
        const [tenantRows] = await pool.query(
            'SELECT nome_ejc AS nome, paroquia, endereco, estado_atende, cidade_atende, bairros_atendidos, updated_at FROM tenants_ejc WHERE id = ? LIMIT 1',
            [tenantId]
        );
        if (tenantRows && tenantRows.length) {
            let bairros = [];
            try {
                bairros = tenantRows[0].bairros_atendidos ? JSON.parse(tenantRows[0].bairros_atendidos) : [];
            } catch (_) {
                bairros = [];
            }
            return res.json({
                tenant_id: tenantId,
                nome: tenantRows[0].nome || 'Inconfidentes',
                paroquia: tenantRows[0].paroquia || null,
                endereco: tenantRows[0].endereco || null,
                estado_atende: tenantRows[0].estado_atende || 'Minas Gerais',
                cidade_atende: tenantRows[0].cidade_atende || 'Contagem',
                bairros_atendidos: bairros,
                updated_at: tenantRows[0].updated_at || null
            });
        }
        }

        const [rows] = await pool.query('SELECT nome, paroquia, endereco, estado_atende, cidade_atende, bairros_atendidos, updated_at FROM meu_ejc_config WHERE id = 1 LIMIT 1');
        const nome = rows && rows.length && rows[0].nome ? String(rows[0].nome).trim() : 'Inconfidentes';
        let bairrosLocal = [];
        try {
            bairrosLocal = rows && rows[0] && rows[0].bairros_atendidos ? JSON.parse(rows[0].bairros_atendidos) : [];
        } catch (_) {
            bairrosLocal = [];
        }
        return res.json({
            tenant_id: tenantId || null,
            nome: nome || 'Inconfidentes',
            paroquia: rows && rows[0] ? (rows[0].paroquia || null) : null,
            endereco: rows && rows[0] ? (rows[0].endereco || null) : null,
            estado_atende: rows && rows[0] ? (rows[0].estado_atende || 'Minas Gerais') : 'Minas Gerais',
            cidade_atende: rows && rows[0] ? (rows[0].cidade_atende || 'Contagem') : 'Contagem',
            bairros_atendidos: bairrosLocal,
            updated_at: rows && rows[0] ? rows[0].updated_at : null
        });
    } catch (err) {
        console.error('Erro ao buscar configuração do Meu EJC:', err);
        return res.status(500).json({ error: 'Erro ao buscar configuração do Meu EJC.' });
    }
});

router.put('/', async (req, res) => {
    try {
        await ensureTenantStructure();
        await garantirEstrutura();
        const bairrosAtendidos = Array.isArray(req.body && req.body.bairros_atendidos)
            ? Array.from(new Set(
                req.body.bairros_atendidos
                    .map((item) => String(item || '').trim())
                    .filter(Boolean)
            ))
            : [];

        const tenantId = req.user && req.user.tenant_id ? Number(req.user.tenant_id) : 0;
        if (tenantId) {
            const [[tenantAtual]] = await pool.query(
                'SELECT nome_ejc AS nome, paroquia, endereco, estado_atende, cidade_atende FROM tenants_ejc WHERE id = ? LIMIT 1',
                [tenantId]
            );
            if (!tenantAtual) {
                return res.status(404).json({ error: 'EJC não encontrado.' });
            }
            await pool.query(
                'UPDATE tenants_ejc SET bairros_atendidos = ? WHERE id = ?',
                [JSON.stringify(bairrosAtendidos), tenantId]
            );
            return res.json({
                message: 'Bairros atendidos atualizados com sucesso.',
                tenant_id: tenantId,
                nome: tenantAtual.nome || 'Inconfidentes',
                paroquia: tenantAtual.paroquia || null,
                endereco: tenantAtual.endereco || null,
                estado_atende: tenantAtual.estado_atende || 'Minas Gerais',
                cidade_atende: tenantAtual.cidade_atende || 'Contagem',
                bairros_atendidos: bairrosAtendidos
            });
        }

        const [[configAtual]] = await pool.query(
            'SELECT nome, paroquia, endereco, estado_atende, cidade_atende FROM meu_ejc_config WHERE id = 1 LIMIT 1'
        );
        await pool.query(
            'UPDATE meu_ejc_config SET bairros_atendidos = ? WHERE id = 1',
            [JSON.stringify(bairrosAtendidos)]
        );
        return res.json({
            message: 'Bairros atendidos atualizados com sucesso.',
            tenant_id: tenantId || null,
            nome: configAtual && configAtual.nome ? configAtual.nome : 'Inconfidentes',
            paroquia: configAtual ? (configAtual.paroquia || null) : null,
            endereco: configAtual ? (configAtual.endereco || null) : null,
            estado_atende: configAtual ? (configAtual.estado_atende || 'Minas Gerais') : 'Minas Gerais',
            cidade_atende: configAtual ? (configAtual.cidade_atende || 'Contagem') : 'Contagem',
            bairros_atendidos: bairrosAtendidos
        });
    } catch (err) {
        console.error('Erro ao salvar configuração do Meu EJC:', err);
        return res.status(500).json({ error: 'Erro ao salvar configuração do Meu EJC.' });
    }
});

module.exports = router;
