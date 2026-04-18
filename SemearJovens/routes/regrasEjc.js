const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { getTenantId } = require('../lib/tenantIsolation');

const REGRAS_PADRAO = Object.freeze({
    coordenador_tipo_casal: 'LIVRE',
    permite_tios_coordenadores: 1,
    idade_maxima_coordenador_jovem: null,
    permite_casal_amasiado_servir: 1,
    casal_amasiado_regra_equipe: 'INDIFERENTE',
    anos_casado_sem_ecc_pode_servir: null
});

async function garantirRegrasPadraoParaEjc(tenantId, ejcId) {
    await pool.query(
        `INSERT IGNORE INTO ejc_regras (
            tenant_id, ejc_id, coordenador_tipo_casal, permite_tios_coordenadores,
            idade_maxima_coordenador_jovem, permite_casal_amasiado_servir,
            casal_amasiado_regra_equipe, anos_casado_sem_ecc_pode_servir
        ) VALUES (?, ?, 'LIVRE', 1, NULL, 1, 'INDIFERENTE', NULL)`,
        [tenantId, ejcId]
    );
}

async function garantirEdicoesDasMontagensAtivas(tenantId) {
    const [montagens] = await pool.query(`
        SELECT m.id,
               m.numero_ejc,
               m.data_encontro,
               m.data_inicio,
               m.data_fim,
               m.data_tarde_revelacao,
               m.data_inicio_reunioes,
               m.data_fim_reunioes
        FROM montagens m
        WHERE m.tenant_id = ?
        ORDER BY m.id DESC
    `, [tenantId]);

    if (!montagens || !montagens.length) return;

    const [[tenantRow]] = await pool.query(
        'SELECT paroquia FROM tenants_ejc WHERE id = ? LIMIT 1',
        [tenantId]
    );
    const paroquiaPadrao = tenantRow && tenantRow.paroquia ? tenantRow.paroquia : null;
    const numerosProcessados = new Set();

    for (const montagem of montagens) {
        const numero = Number(montagem.numero_ejc || 0);
        if (!Number.isInteger(numero) || numero <= 0 || numerosProcessados.has(numero)) continue;
        numerosProcessados.add(numero);

        const [[ejcExistente]] = await pool.query(
            'SELECT id FROM ejc WHERE tenant_id = ? AND numero = ? LIMIT 1',
            [tenantId, numero]
        );

        const anoBase = (montagem.data_inicio || montagem.data_encontro)
            ? Number(String(montagem.data_inicio || montagem.data_encontro).slice(0, 4))
            : new Date().getFullYear();

        if (ejcExistente && ejcExistente.id) {
            await garantirRegrasPadraoParaEjc(tenantId, ejcExistente.id);
            continue;
        }

        const [insertRes] = await pool.query(
            `INSERT INTO ejc (
                tenant_id, numero, paroquia, ano, data_inicio, data_fim,
                data_encontro, data_tarde_revelacao, data_inicio_reunioes,
                data_fim_reunioes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                tenantId,
                numero,
                paroquiaPadrao,
                Number.isFinite(anoBase) ? anoBase : new Date().getFullYear(),
                montagem.data_inicio || montagem.data_encontro || null,
                montagem.data_fim || montagem.data_tarde_revelacao || montagem.data_encontro || null,
                montagem.data_encontro || null,
                montagem.data_tarde_revelacao || null,
                montagem.data_inicio_reunioes || null,
                montagem.data_fim_reunioes || null
            ]
        );

        await pool.query(
            `INSERT IGNORE INTO equipes_ejc (tenant_id, ejc_id, equipe_id)
             SELECT ?, ?, id FROM equipes WHERE tenant_id = ?`,
            [tenantId, insertRes.insertId, tenantId]
        );
        await garantirRegrasPadraoParaEjc(tenantId, insertRes.insertId);
    }
}

async function garantirEstruturaRegrasEjc() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ejc_regras (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            ejc_id INT NOT NULL,
            coordenador_tipo_casal VARCHAR(40) NOT NULL DEFAULT 'LIVRE',
            permite_tios_coordenadores TINYINT(1) NOT NULL DEFAULT 1,
            idade_maxima_coordenador_jovem INT NULL DEFAULT NULL,
            permite_casal_amasiado_servir TINYINT(1) NOT NULL DEFAULT 1,
            casal_amasiado_regra_equipe VARCHAR(40) NOT NULL DEFAULT 'INDIFERENTE',
            anos_casado_sem_ecc_pode_servir INT NULL DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_ejc_regras_tenant (tenant_id, ejc_id),
            KEY idx_ejc_regras_ejc (ejc_id),
            CONSTRAINT fk_ejc_regras_ejc FOREIGN KEY (ejc_id) REFERENCES ejc(id) ON DELETE CASCADE
        )
    `);
}

function normalizarInteiroOpcional(valor) {
    if (valor === undefined || valor === null || String(valor).trim() === '') return null;
    const numero = Number(valor);
    if (!Number.isFinite(numero) || numero < 0) return null;
    return Math.floor(numero);
}

function normalizarCoordenadorTipoCasal(valor) {
    return String(valor || '').trim().toUpperCase() === 'JOVEM_HOMEM_E_MULHER'
        ? 'JOVEM_HOMEM_E_MULHER'
        : 'LIVRE';
}

function normalizarCasalAmasiadoRegraEquipe(valor) {
    const regra = String(valor || '').trim().toUpperCase();
    if (regra === 'MESMA_EQUIPE') return 'MESMA_EQUIPE';
    if (regra === 'EQUIPES_SEPARADAS') return 'EQUIPES_SEPARADAS';
    return 'INDIFERENTE';
}

function mapearLinhaRegras(row) {
    return {
        ...REGRAS_PADRAO,
        ...(row || {}),
        coordenador_tipo_casal: row && row.coordenador_tipo_casal ? row.coordenador_tipo_casal : REGRAS_PADRAO.coordenador_tipo_casal,
        permite_tios_coordenadores: row && row.permite_tios_coordenadores !== null && row.permite_tios_coordenadores !== undefined
            ? (Number(row.permite_tios_coordenadores) === 1 ? 1 : 0)
            : REGRAS_PADRAO.permite_tios_coordenadores,
        idade_maxima_coordenador_jovem: row && row.idade_maxima_coordenador_jovem !== null ? Number(row.idade_maxima_coordenador_jovem) : null,
        permite_casal_amasiado_servir: row && row.permite_casal_amasiado_servir !== null && row.permite_casal_amasiado_servir !== undefined
            ? (Number(row.permite_casal_amasiado_servir) === 1 ? 1 : 0)
            : REGRAS_PADRAO.permite_casal_amasiado_servir,
        casal_amasiado_regra_equipe: row && row.casal_amasiado_regra_equipe ? row.casal_amasiado_regra_equipe : REGRAS_PADRAO.casal_amasiado_regra_equipe,
        anos_casado_sem_ecc_pode_servir: row && row.anos_casado_sem_ecc_pode_servir !== null ? Number(row.anos_casado_sem_ecc_pode_servir) : null,
        regras_editaveis: row && row.regras_editaveis !== null && row.regras_editaveis !== undefined
            ? (Number(row.regras_editaveis) === 1 ? 1 : 0)
            : 0
    };
}

async function buscarEdicaoComStatusRegras(tenantId, ejcId) {
    const [[row]] = await pool.query(`
        SELECT e.id AS ejc_id,
               e.numero,
               e.paroquia,
               e.ano,
               e.data_encontro,
               e.data_inicio,
               e.data_fim,
               er.coordenador_tipo_casal,
               er.permite_tios_coordenadores,
               er.idade_maxima_coordenador_jovem,
               er.permite_casal_amasiado_servir,
               er.casal_amasiado_regra_equipe,
               er.anos_casado_sem_ecc_pode_servir,
               er.updated_at,
               CASE
                   WHEN EXISTS (
                       SELECT 1
                       FROM montagens m
                       WHERE m.tenant_id = e.tenant_id
                         AND m.numero_ejc = e.numero
                   ) THEN 1
                   ELSE 0
               END AS regras_editaveis
        FROM ejc e
        LEFT JOIN ejc_regras er
          ON er.ejc_id = e.id
         AND er.tenant_id = e.tenant_id
        WHERE e.id = ?
          AND e.tenant_id = ?
        LIMIT 1
    `, [ejcId, tenantId]);

    return row || null;
}

router.get('/', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        await garantirEstruturaRegrasEjc();
        await garantirEdicoesDasMontagensAtivas(tenantId);
        const [rows] = await pool.query(`
            SELECT e.id AS ejc_id,
                   e.numero,
                   e.paroquia,
                   e.ano,
                   e.data_encontro,
                   e.data_inicio,
                   e.data_fim,
                   er.coordenador_tipo_casal,
                   er.permite_tios_coordenadores,
                   er.idade_maxima_coordenador_jovem,
                   er.permite_casal_amasiado_servir,
                   er.casal_amasiado_regra_equipe,
                   er.anos_casado_sem_ecc_pode_servir,
                   er.updated_at,
                   CASE
                       WHEN EXISTS (
                           SELECT 1
                           FROM montagens m
                           WHERE m.tenant_id = e.tenant_id
                             AND m.numero_ejc = e.numero
                       ) THEN 1
                       ELSE 0
                   END AS regras_editaveis
            FROM ejc e
            LEFT JOIN ejc_regras er
              ON er.ejc_id = e.id
             AND er.tenant_id = e.tenant_id
            WHERE e.tenant_id = ?
            ORDER BY e.numero DESC
        `, [tenantId]);
        res.json(rows.map(mapearLinhaRegras));
    } catch (err) {
        console.error('Erro ao buscar regras dos EJCs:', err);
        res.status(500).json({ error: 'Erro ao buscar regras dos EJCs.' });
    }
});

router.get('/:ejcId', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        await garantirEstruturaRegrasEjc();
        await garantirEdicoesDasMontagensAtivas(tenantId);
        const ejcId = Number(req.params.ejcId);
        if (!ejcId) return res.status(400).json({ error: 'EJC inválido.' });

        const row = await buscarEdicaoComStatusRegras(tenantId, ejcId);
        if (!row) return res.status(404).json({ error: 'EJC não encontrado.' });
        res.json(mapearLinhaRegras(row));
    } catch (err) {
        console.error('Erro ao buscar regra do EJC:', err);
        res.status(500).json({ error: 'Erro ao buscar regra do EJC.' });
    }
});

router.put('/:ejcId', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        await garantirEstruturaRegrasEjc();
        await garantirEdicoesDasMontagensAtivas(tenantId);
        const ejcId = Number(req.params.ejcId);
        if (!ejcId) return res.status(400).json({ error: 'EJC inválido.' });

        const ejc = await buscarEdicaoComStatusRegras(tenantId, ejcId);
        if (!ejc) return res.status(404).json({ error: 'EJC não encontrado.' });
        if (!Number(ejc.regras_editaveis)) {
            return res.status(403).json({
                error: 'As regras desta edição não podem mais ser alteradas porque a montagem já foi finalizada.'
            });
        }

        const payload = {
            coordenador_tipo_casal: normalizarCoordenadorTipoCasal(req.body && req.body.coordenador_tipo_casal),
            permite_tios_coordenadores: req.body && req.body.permite_tios_coordenadores ? 1 : 0,
            idade_maxima_coordenador_jovem: normalizarInteiroOpcional(req.body && req.body.idade_maxima_coordenador_jovem),
            permite_casal_amasiado_servir: req.body && req.body.permite_casal_amasiado_servir ? 1 : 0,
            casal_amasiado_regra_equipe: normalizarCasalAmasiadoRegraEquipe(req.body && req.body.casal_amasiado_regra_equipe),
            anos_casado_sem_ecc_pode_servir: normalizarInteiroOpcional(req.body && req.body.anos_casado_sem_ecc_pode_servir)
        };

        await pool.query(`
            INSERT INTO ejc_regras (
                tenant_id, ejc_id, coordenador_tipo_casal, permite_tios_coordenadores,
                idade_maxima_coordenador_jovem, permite_casal_amasiado_servir,
                casal_amasiado_regra_equipe, anos_casado_sem_ecc_pode_servir
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                coordenador_tipo_casal = VALUES(coordenador_tipo_casal),
                permite_tios_coordenadores = VALUES(permite_tios_coordenadores),
                idade_maxima_coordenador_jovem = VALUES(idade_maxima_coordenador_jovem),
                permite_casal_amasiado_servir = VALUES(permite_casal_amasiado_servir),
                casal_amasiado_regra_equipe = VALUES(casal_amasiado_regra_equipe),
                anos_casado_sem_ecc_pode_servir = VALUES(anos_casado_sem_ecc_pode_servir)
        `, [
            tenantId,
            ejcId,
            payload.coordenador_tipo_casal,
            payload.permite_tios_coordenadores,
            payload.idade_maxima_coordenador_jovem,
            payload.permite_casal_amasiado_servir,
            payload.casal_amasiado_regra_equipe,
            payload.anos_casado_sem_ecc_pode_servir
        ]);

        res.json({ message: 'Regras salvas com sucesso.' });
    } catch (err) {
        console.error('Erro ao salvar regra do EJC:', err);
        res.status(500).json({ error: 'Erro ao salvar regra do EJC.' });
    }
});

module.exports = router;
