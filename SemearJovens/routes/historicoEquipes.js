const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { getTenantId } = require('../lib/tenantIsolation');
const {
    ensureHistoricoEquipesSnapshots,
    ensureHistoricoEquipesYoungFkPreserved,
    backfillHistoricoEquipesSnapshots
} = require('../lib/ejcHistorySnapshots');
const { decryptJovemPhone } = require('../lib/jovensSensitiveData');
const { decryptTioPhone } = require('../lib/tiosSensitiveData');

let hasSubfuncaoColumnCache = null;
function decryptMixedPhones(value) {
    return String(value || '')
        .split('/')
        .map((parte) => {
            const texto = String(parte || '').trim();
            if (!texto || texto === '-') return texto || '-';
            return decryptJovemPhone(texto) || decryptTioPhone(texto) || texto;
        })
        .join(' / ');
}

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

function normalizarTextoOrdenacao(valor) {
    return String(valor || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function subfuncaoPadrao(item) {
    const subfuncao = String(item && item.subfuncao ? item.subfuncao : '').trim();
    if (subfuncao) return subfuncao;
    const papel = normalizarTextoOrdenacao(item && item.papel);
    return papel === 'tio' || papel === 'tios' ? 'Tios' : 'Membro';
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

        const [funcoesRows] = await pool.query(`
            SELECT DISTINCT ef.nome, COALESCE(ef.papel_base, 'Membro') AS papel_base
            FROM equipes_funcoes ef
            JOIN equipes eq
              ON eq.id = ef.equipe_id
             AND eq.tenant_id = ef.tenant_id
            WHERE ef.tenant_id = ?
              AND (
                    ef.equipe_id = ?
                    OR LOWER(TRIM(eq.nome)) = LOWER(TRIM(?))
              )
            ORDER BY ef.nome ASC
        `, [tenantId, Number.isInteger(equipeIdNumero) && equipeIdNumero > 0 ? equipeIdNumero : 0, nomeEquipe]);
        const ordemSubfuncoes = new Map();
        (funcoesRows || []).forEach((funcao) => {
            const nomeFuncao = String(funcao && funcao.nome ? funcao.nome : '').trim();
            if (!nomeFuncao) return;
            const chave = normalizarTextoOrdenacao(nomeFuncao);
            if (!ordemSubfuncoes.has(chave)) ordemSubfuncoes.set(chave, ordemSubfuncoes.size);
        });

        const comSubfuncao = await hasSubfuncaoColumn();
        const subfuncaoSelect = comSubfuncao
            ? `COALESCE(NULLIF(TRIM(he.subfuncao), ''), CASE WHEN LOWER(TRIM(COALESCE(he.papel, ''))) IN ('tio', 'tios') THEN 'Tios' ELSE 'Membro' END) AS subfuncao`
            : `CASE WHEN LOWER(TRIM(COALESCE(he.papel, ''))) IN ('tio', 'tios') THEN 'Tios' ELSE 'Membro' END AS subfuncao`;
        const [jovensRows] = await pool.query(`
            SELECT DISTINCT
                COALESCE(j.id, he.jovem_id) AS id,
                COALESCE(he.nome_completo_snapshot, j.nome_completo) AS nome_completo,
                COALESCE(he.telefone_snapshot, j.telefone) AS telefone,
                he.papel,
                j.sexo AS sexo,
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
                COALESCE(NULLIF(TRIM(ts.papel), ''), 'Tios') AS papel,
                NULL AS sexo,
                COALESCE(NULLIF(TRIM(ts.subfuncao), ''), 'Tios') AS subfuncao,
                NULL AS numero_ejc_fez,
                e.numero AS ecc_numero,
                e.tipo AS ecc_tipo,
                CASE
                    WHEN c.outro_ejc_id IS NOT NULL THEN 'OUTRO_EJC'
                    ELSE COALESCE(c.origem_tipo, 'EJC')
                END AS origem_ejc_tipo,
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
                COALESCE(NULLIF(TRIM(th.papel), ''), 'Tios') AS papel,
                NULL AS sexo,
                COALESCE(NULLIF(TRIM(th.subfuncao), ''), 'Tios') AS subfuncao,
                NULL AS numero_ejc_fez,
                e.numero AS ecc_numero,
                e.tipo AS ecc_tipo,
                CASE
                    WHEN c.outro_ejc_id IS NOT NULL THEN 'OUTRO_EJC'
                    ELSE COALESCE(c.origem_tipo, 'EJC')
                END AS origem_ejc_tipo,
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
            item.telefone = decryptMixedPhones(item.telefone);
            item.subfuncao = subfuncaoPadrao(item);
            const chave = [
                String(item.nome_completo || '').trim().toLowerCase(),
                String(item.telefone || '').trim(),
                String(item.papel || '').trim().toLowerCase()
            ].join('|');
            if (!unicos.has(chave)) unicos.set(chave, item);
        });
        const rows = Array.from(unicos.values())
            .sort((a, b) => {
                const ordemA = ordemSubfuncoes.has(normalizarTextoOrdenacao(a.subfuncao))
                    ? ordemSubfuncoes.get(normalizarTextoOrdenacao(a.subfuncao))
                    : Number.MAX_SAFE_INTEGER;
                const ordemB = ordemSubfuncoes.has(normalizarTextoOrdenacao(b.subfuncao))
                    ? ordemSubfuncoes.get(normalizarTextoOrdenacao(b.subfuncao))
                    : Number.MAX_SAFE_INTEGER;
                if (ordemA !== ordemB) return ordemA - ordemB;
                const subCmp = String(a.subfuncao || '').localeCompare(String(b.subfuncao || ''), 'pt-BR');
                if (subCmp) return subCmp;
                return String(a.nome_completo || '').localeCompare(String(b.nome_completo || ''), 'pt-BR');
            });
        res.json(rows);
    } catch (err) {
        console.error("Erro ao buscar jovens da equipe:", err);
        res.status(500).json({ error: "Erro no servidor" });
    }
});

module.exports = router;
