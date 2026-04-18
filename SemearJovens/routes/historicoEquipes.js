const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { getTenantId } = require('../lib/tenantIsolation');
const {
    ensureHistoricoEquipesSnapshots,
    ensureHistoricoEquipesYoungFkPreserved,
    backfillHistoricoEquipesSnapshots
} = require('../lib/ejcHistorySnapshots');

let hasSubfuncaoColumnCache = null;
async function hasSubfuncaoColumn() {
    if (hasSubfuncaoColumnCache !== null) return hasSubfuncaoColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'historico_equipes'
          AND COLUMN_NAME = 'subfuncao'
    `);
    hasSubfuncaoColumnCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasSubfuncaoColumnCache;
}

// GET - Jovens de uma equipe em um EJC específico
router.get('/:equipeId/jovens/:ejcId', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        await ensureHistoricoEquipesSnapshots();
        await ensureHistoricoEquipesYoungFkPreserved();
        await backfillHistoricoEquipesSnapshots({ tenantId, ejcId: req.params.ejcId });
        const equipeIdNumero = Number(req.params.equipeId);
        let nomeEquipe = '';

        if (Number.isInteger(equipeIdNumero) && equipeIdNumero > 0) {
            const [equipeRows] = await pool.query(
                'SELECT nome FROM equipes WHERE id = ? AND tenant_id = ?',
                [equipeIdNumero, tenantId]
            );
            if (equipeRows.length > 0) {
                nomeEquipe = String(equipeRows[0].nome || '').trim();
            }
        }

        if (!nomeEquipe) {
            nomeEquipe = decodeURIComponent(String(req.params.equipeId || '')).trim();
        }
        if (!nomeEquipe) {
            return res.status(404).json({ error: "Equipe não encontrada" });
        }

        const comSubfuncao = await hasSubfuncaoColumn();
        const subfuncaoSelect = comSubfuncao ? 'he.subfuncao' : 'NULL as subfuncao';
        const [jovensRows] = await pool.query(`
            SELECT DISTINCT
                COALESCE(j.id, he.jovem_id) AS id,
                COALESCE(he.nome_completo_snapshot, j.nome_completo) AS nome_completo,
                COALESCE(he.telefone_snapshot, j.telefone) AS telefone,
                he.papel,
                ${subfuncaoSelect},
                eorig.numero AS numero_ejc_fez,
                COALESCE(he.origem_ejc_tipo_snapshot, j.origem_ejc_tipo, 'INCONFIDENTES') AS origem_ejc_tipo,
                COALESCE(he.outro_ejc_numero_snapshot, j.outro_ejc_numero) AS outro_ejc_numero,
                COALESCE(he.outro_ejc_id_snapshot, j.outro_ejc_id) AS outro_ejc_id,
                COALESCE(he.outro_ejc_nome_snapshot, oe.nome) AS outro_ejc_nome,
                COALESCE(he.outro_ejc_paroquia_snapshot, oe.paroquia) AS outro_ejc_paroquia
            FROM historico_equipes he
            LEFT JOIN jovens j
              ON j.id = he.jovem_id
             AND j.tenant_id = he.tenant_id
            LEFT JOIN ejc eorig
              ON eorig.id = j.numero_ejc_fez
             AND eorig.tenant_id = he.tenant_id
            LEFT JOIN outros_ejcs oe
              ON oe.id = COALESCE(he.outro_ejc_id_snapshot, j.outro_ejc_id)
             AND oe.tenant_id = he.tenant_id
            WHERE he.tenant_id = ?
              AND he.equipe = ?
              AND he.ejc_id = ?
            ORDER BY COALESCE(he.nome_completo_snapshot, j.nome_completo) ASC
        `, [tenantId, nomeEquipe, req.params.ejcId]);

        const [tiosRows] = await pool.query(`
            SELECT DISTINCT
                CONCAT('tio-', COALESCE(c.id, ts.casal_id, ts.id)) AS id,
                CONCAT(
                    COALESCE(c.nome_tio, ts.nome_tio_snapshot, ''),
                    ' e ',
                    COALESCE(c.nome_tia, ts.nome_tia_snapshot, '')
                ) AS nome_completo,
                CONCAT(
                    COALESCE(c.telefone_tio, ts.telefone_tio_snapshot, '-'),
                    ' / ',
                    COALESCE(c.telefone_tia, ts.telefone_tia_snapshot, '-')
                ) AS telefone,
                'Tios' AS papel,
                NULL AS subfuncao,
                NULL AS numero_ejc_fez,
                e.numero AS ecc_numero,
                e.tipo AS ecc_tipo,
                COALESCE(c.origem_tipo, 'EJC') AS origem_ejc_tipo,
                NULL AS outro_ejc_numero,
                c.outro_ejc_id AS outro_ejc_id,
                oe.nome AS outro_ejc_nome,
                oe.paroquia AS outro_ejc_paroquia
            FROM tios_casal_servicos ts
            LEFT JOIN tios_casais c
              ON c.id = ts.casal_id
             AND c.tenant_id = ts.tenant_id
            LEFT JOIN tios_ecc e
              ON e.id = c.ecc_id
             AND e.tenant_id = ts.tenant_id
            LEFT JOIN outros_ejcs oe
              ON oe.id = c.outro_ejc_id
             AND oe.tenant_id = ts.tenant_id
            WHERE ts.tenant_id = ?
              AND ts.equipe_id = ?
              AND ts.ejc_id = ?
            ORDER BY nome_completo ASC
        `, [tenantId, req.params.equipeId, req.params.ejcId]);

        const [tiosHistoricoRows] = await pool.query(`
            SELECT DISTINCT
                CONCAT('tio-hist-', th.id) AS id,
                CONCAT(
                    COALESCE(c.nome_tio, th.nome_tio_snapshot, ''),
                    ' e ',
                    COALESCE(c.nome_tia, th.nome_tia_snapshot, '')
                ) AS nome_completo,
                CONCAT(
                    COALESCE(c.telefone_tio, th.telefone_tio_snapshot, '-'),
                    ' / ',
                    COALESCE(c.telefone_tia, th.telefone_tia_snapshot, '-')
                ) AS telefone,
                'Tios' AS papel,
                NULL AS subfuncao,
                NULL AS numero_ejc_fez,
                e.numero AS ecc_numero,
                e.tipo AS ecc_tipo,
                COALESCE(c.origem_tipo, 'EJC') AS origem_ejc_tipo,
                NULL AS outro_ejc_numero,
                c.outro_ejc_id AS outro_ejc_id,
                oe.nome AS outro_ejc_nome,
                oe.paroquia AS outro_ejc_paroquia
            FROM tios_casal_servicos_historico th
            LEFT JOIN tios_casais c
              ON c.id = th.casal_id
             AND c.tenant_id = th.tenant_id
            LEFT JOIN tios_ecc e
              ON e.id = c.ecc_id
             AND e.tenant_id = th.tenant_id
            LEFT JOIN outros_ejcs oe
              ON oe.id = c.outro_ejc_id
             AND oe.tenant_id = th.tenant_id
            WHERE th.tenant_id = ?
              AND th.equipe_id = ?
              AND th.ejc_id = ?
            ORDER BY nome_completo ASC
        `, [tenantId, req.params.equipeId, req.params.ejcId]);

        const unicos = new Map();
        [...(jovensRows || []), ...(tiosRows || []), ...(tiosHistoricoRows || [])].forEach((item) => {
            const chave = [
                String(item.nome_completo || '').trim().toLowerCase(),
                String(item.telefone || '').trim(),
                String(item.papel || '').trim().toLowerCase()
            ].join('|');
            if (!unicos.has(chave)) unicos.set(chave, item);
        });
        const rows = Array.from(unicos.values())
            .sort((a, b) => String(a.nome_completo || '').localeCompare(String(b.nome_completo || ''), 'pt-BR'));
        res.json(rows);
    } catch (err) {
        console.error("Erro ao buscar jovens da equipe:", err);
        res.status(500).json({ error: "Erro no servidor" });
    }
});

module.exports = router;
