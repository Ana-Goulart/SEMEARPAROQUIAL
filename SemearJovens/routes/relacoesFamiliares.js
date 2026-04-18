const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { getTenantId } = require('../lib/tenantIsolation');
const {
    ENTITY_TYPES,
    ensureRelacoesFamiliaresTable,
    normalizeEntityType,
    normalizeRelationType,
    relationLabel,
    relationAllowedForPair,
    canonicalizeRelation,
    entityExists,
    getAllowedRelationsForSourceType
} = require('../lib/relacoesFamiliares');

function formatarDetalheJovem(row) {
    const origem = String(row.origem_ejc_tipo || '').toUpperCase() === 'OUTRO_EJC'
        ? [row.outro_ejc_paroquia, row.outro_ejc_nome].filter(Boolean).join(' - ') || 'Jovem de outro EJC'
        : 'Lista Mestre';
    return {
        nome_exibicao: row.nome_completo || 'Jovem',
        descricao: origem,
        telefone: row.telefone || ''
    };
}

function formatarDetalheCasal(row) {
    const origem = String(row.origem_tipo || '').toUpperCase() === 'OUTRO_EJC'
        ? [row.outro_ejc_paroquia, row.outro_ejc_nome].filter(Boolean).join(' - ') || 'Tios de outro EJC'
        : 'Tios';
    return {
        nome_exibicao: [row.nome_tio, row.nome_tia].filter(Boolean).join(' e ') || 'Casal de tios',
        descricao: origem,
        telefone: [row.telefone_tio, row.telefone_tia].filter(Boolean).join(' / ')
    };
}

const PARTICULAS_SOBRENOME = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

function normalizarTexto(valor) {
    return String(valor || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function extrairSobrenomes(nomeCompleto) {
    const partes = String(nomeCompleto || '')
        .trim()
        .split(/\s+/)
        .map((item) => normalizarTexto(item))
        .filter(Boolean);
    if (partes.length <= 1) return [];
    return partes
        .slice(1)
        .filter((item) => item.length >= 2 && !PARTICULAS_SOBRENOME.has(item));
}

function obterSobrenomesDaEntidade(item) {
    if (!item) return [];
    if (item.entity_type === ENTITY_TYPES.JOVEM) {
        return extrairSobrenomes(item.nome_completo);
    }
    const nomes = [item.nome_tio, item.nome_tia].filter(Boolean);
    return Array.from(new Set(nomes.flatMap((nome) => extrairSobrenomes(nome))));
}

function listasIguaisComoConjunto(listaA, listaB) {
    const a = Array.from(new Set((listaA || []).filter(Boolean))).sort();
    const b = Array.from(new Set((listaB || []).filter(Boolean))).sort();
    if (a.length === 0 || b.length === 0) return false;
    if (a.length !== b.length) return false;
    return a.every((item, idx) => item === b[idx]);
}

function detalharEntidadeParaLista(item) {
    if (item.entity_type === ENTITY_TYPES.JOVEM) return formatarDetalheJovem(item);
    return formatarDetalheCasal(item);
}

async function listarEntidadesRelacionaveis(tenantId, { sourceType, sourceId, q = '' } = {}) {
    const termo = String(q || '').trim();
    const temBusca = termo.length > 0;
    const like = `%${termo}%`;
    const results = [];

    const youngParams = [tenantId];
    let youngWhere = 'j.tenant_id = ?';
    if (temBusca) {
        youngWhere += ' AND j.nome_completo LIKE ?';
        youngParams.push(like);
    }
    if (sourceType === ENTITY_TYPES.JOVEM && sourceId) {
        youngWhere += ' AND j.id <> ?';
        youngParams.push(sourceId);
    }
    const [jovens] = await pool.query(
        `SELECT j.id, j.nome_completo, j.telefone,
                COALESCE(j.origem_ejc_tipo, 'INCONFIDENTES') AS origem_ejc_tipo,
                oe.nome AS outro_ejc_nome, oe.paroquia AS outro_ejc_paroquia
         FROM jovens j
         LEFT JOIN outros_ejcs oe ON oe.id = j.outro_ejc_id AND oe.tenant_id = j.tenant_id
         WHERE ${youngWhere}
         ORDER BY j.nome_completo ASC`,
        youngParams
    );
    for (const row of (jovens || [])) {
        results.push({ entity_type: ENTITY_TYPES.JOVEM, entity_id: Number(row.id), nome_completo: row.nome_completo || '', ...formatarDetalheJovem(row) });
    }

    const tiosParams = [tenantId];
    let tiosWhere = 'c.tenant_id = ?';
    if (temBusca) {
        tiosWhere += ' AND (c.nome_tio LIKE ? OR c.nome_tia LIKE ?)';
        tiosParams.push(like, like);
    }
    if (sourceType === ENTITY_TYPES.TIO_CASAL && sourceId) {
        tiosWhere += ' AND c.id <> ?';
        tiosParams.push(sourceId);
    }
    const [casais] = await pool.query(
        `SELECT c.id, c.nome_tio, c.nome_tia, c.telefone_tio, c.telefone_tia,
                COALESCE(c.origem_tipo, 'EJC') AS origem_tipo,
                oe.nome AS outro_ejc_nome, oe.paroquia AS outro_ejc_paroquia
         FROM tios_casais c
         LEFT JOIN outros_ejcs oe ON oe.id = c.outro_ejc_id AND oe.tenant_id = c.tenant_id
         WHERE ${tiosWhere}
         ORDER BY c.nome_tio ASC, c.nome_tia ASC`,
        tiosParams
    );
    for (const row of (casais || [])) {
        results.push({
            entity_type: ENTITY_TYPES.TIO_CASAL,
            entity_id: Number(row.id),
            nome_tio: row.nome_tio || '',
            nome_tia: row.nome_tia || '',
            ...formatarDetalheCasal(row)
        });
    }

    return results;
}

async function carregarEntidadeBase(tenantId, entityType, entityId) {
    if (entityType === ENTITY_TYPES.JOVEM) {
        const [rows] = await pool.query(
            `SELECT j.id, j.nome_completo, j.telefone,
                    COALESCE(j.origem_ejc_tipo, 'INCONFIDENTES') AS origem_ejc_tipo,
                    oe.nome AS outro_ejc_nome, oe.paroquia AS outro_ejc_paroquia
             FROM jovens j
             LEFT JOIN outros_ejcs oe ON oe.id = j.outro_ejc_id AND oe.tenant_id = j.tenant_id
             WHERE j.tenant_id = ? AND j.id = ?
             LIMIT 1`,
            [tenantId, entityId]
        );
        return rows && rows[0] ? { entity_type: ENTITY_TYPES.JOVEM, entity_id: Number(rows[0].id), ...rows[0] } : null;
    }
    if (entityType === ENTITY_TYPES.TIO_CASAL) {
        const [rows] = await pool.query(
            `SELECT c.id, c.nome_tio, c.nome_tia, c.telefone_tio, c.telefone_tia,
                    COALESCE(c.origem_tipo, 'EJC') AS origem_tipo,
                    oe.nome AS outro_ejc_nome, oe.paroquia AS outro_ejc_paroquia
             FROM tios_casais c
             LEFT JOIN outros_ejcs oe ON oe.id = c.outro_ejc_id AND oe.tenant_id = c.tenant_id
             WHERE c.tenant_id = ? AND c.id = ?
             LIMIT 1`,
            [tenantId, entityId]
        );
        return rows && rows[0] ? { entity_type: ENTITY_TYPES.TIO_CASAL, entity_id: Number(rows[0].id), ...rows[0] } : null;
    }
    return null;
}

async function buscarDetalhesEntidades(tenantId, itens) {
    const jovensIds = Array.from(new Set(itens.filter((i) => i.entity_type === ENTITY_TYPES.JOVEM).map((i) => Number(i.entity_id)).filter(Boolean)));
    const tiosIds = Array.from(new Set(itens.filter((i) => i.entity_type === ENTITY_TYPES.TIO_CASAL).map((i) => Number(i.entity_id)).filter(Boolean)));
    const jovensMap = new Map();
    const tiosMap = new Map();

    if (jovensIds.length) {
        const placeholders = jovensIds.map(() => '?').join(',');
        const [rows] = await pool.query(
            `SELECT j.id, j.nome_completo, j.telefone,
                    COALESCE(j.origem_ejc_tipo, 'INCONFIDENTES') AS origem_ejc_tipo,
                    oe.nome AS outro_ejc_nome, oe.paroquia AS outro_ejc_paroquia
             FROM jovens j
             LEFT JOIN outros_ejcs oe ON oe.id = j.outro_ejc_id AND oe.tenant_id = j.tenant_id
             WHERE j.tenant_id = ?
               AND j.id IN (${placeholders})`,
            [tenantId, ...jovensIds]
        );
        (rows || []).forEach((row) => jovensMap.set(Number(row.id), row));
    }

    if (tiosIds.length) {
        const placeholders = tiosIds.map(() => '?').join(',');
        const [rows] = await pool.query(
            `SELECT c.id, c.nome_tio, c.nome_tia, c.telefone_tio, c.telefone_tia,
                    COALESCE(c.origem_tipo, 'EJC') AS origem_tipo,
                    oe.nome AS outro_ejc_nome, oe.paroquia AS outro_ejc_paroquia
             FROM tios_casais c
             LEFT JOIN outros_ejcs oe ON oe.id = c.outro_ejc_id AND oe.tenant_id = c.tenant_id
             WHERE c.tenant_id = ?
               AND c.id IN (${placeholders})`,
            [tenantId, ...tiosIds]
        );
        (rows || []).forEach((row) => tiosMap.set(Number(row.id), row));
    }

    return { jovensMap, tiosMap };
}

router.get('/opcoes', async (req, res) => {
    const sourceType = normalizeEntityType(req.query.source_type);
    if (!sourceType) return res.status(400).json({ error: 'Origem inválida.' });
    return res.json(getAllowedRelationsForSourceType(sourceType).map((value) => ({ value, label: relationLabel(value) })));
});

router.get('/search', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const sourceType = normalizeEntityType(req.query.source_type);
        const sourceId = Number(req.query.source_id || 0);
        const q = String(req.query.q || '').trim();
        if (!sourceType || !sourceId) return res.status(400).json({ error: 'Origem inválida.' });
        await ensureRelacoesFamiliaresTable();
        const results = await listarEntidadesRelacionaveis(tenantId, { sourceType, sourceId, q });
        return res.json(results);
    } catch (err) {
        console.error('Erro ao buscar familiares:', err);
        return res.status(500).json({ error: 'Erro ao buscar familiares.' });
    }
});

router.get('/sugestoes', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const entityType = normalizeEntityType(req.query.entity_type);
        const entityId = Number(req.query.entity_id || 0);
        if (!entityType || !entityId) return res.status(400).json({ error: 'Entidade inválida.' });

        await ensureRelacoesFamiliaresTable();
        const origem = await carregarEntidadeBase(tenantId, entityType, entityId);
        if (!origem) return res.status(404).json({ error: 'Cadastro não encontrado.' });

        const sobrenomesOrigem = Array.from(new Set(obterSobrenomesDaEntidade(origem)));
        if (!sobrenomesOrigem.length) return res.json([]);

        const [relacoesExistentes] = await pool.query(
            `SELECT entity_a_type, entity_a_id, entity_b_type, entity_b_id
             FROM relacoes_familiares
             WHERE tenant_id = ?
               AND ((entity_a_type = ? AND entity_a_id = ?) OR (entity_b_type = ? AND entity_b_id = ?))`,
            [tenantId, entityType, entityId, entityType, entityId]
        );
        const relacionados = new Set();
        for (const row of (relacoesExistentes || [])) {
            const key = row.entity_a_type === entityType && Number(row.entity_a_id) === entityId
                ? `${row.entity_b_type}:${Number(row.entity_b_id)}`
                : `${row.entity_a_type}:${Number(row.entity_a_id)}`;
            relacionados.add(key);
        }

        const candidatos = await listarEntidadesRelacionaveis(tenantId, { sourceType: entityType, sourceId: entityId, q: '' });
        const sugestoes = candidatos
            .map((item) => {
                if (relacionados.has(`${item.entity_type}:${item.entity_id}`)) return null;
                const sobrenomesCandidato = Array.from(new Set(obterSobrenomesDaEntidade(item)));
                if (!listasIguaisComoConjunto(sobrenomesOrigem, sobrenomesCandidato)) return null;
                return {
                    ...item,
                    sobrenomes_iguais: sobrenomesCandidato,
                    mensagem: `${item.nome_exibicao} tem exatamente os mesmos sobrenomes deste cadastro.`
                };
            })
            .filter(Boolean)
            .sort((a, b) => {
                if (b.sobrenomes_iguais.length !== a.sobrenomes_iguais.length) return b.sobrenomes_iguais.length - a.sobrenomes_iguais.length;
                return String(a.nome_exibicao || '').localeCompare(String(b.nome_exibicao || ''), 'pt-BR');
            })
            .slice(0, 30);

        return res.json(sugestoes);
    } catch (err) {
        console.error('Erro ao carregar sugestões de parentesco:', err);
        return res.status(500).json({ error: 'Erro ao carregar sugestões de parentesco.' });
    }
});

router.get('/', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const entityType = normalizeEntityType(req.query.entity_type);
        const entityId = Number(req.query.entity_id || 0);
        if (!entityType || !entityId) return res.status(400).json({ error: 'Entidade inválida.' });

        await ensureRelacoesFamiliaresTable();
        const [rows] = await pool.query(
            `SELECT *
             FROM relacoes_familiares
             WHERE tenant_id = ?
               AND ((entity_a_type = ? AND entity_a_id = ?) OR (entity_b_type = ? AND entity_b_id = ?))
             ORDER BY updated_at DESC, id DESC`,
            [tenantId, entityType, entityId, entityType, entityId]
        );

        const itens = rows.map((row) => {
            const sourceIsA = row.entity_a_type === entityType && Number(row.entity_a_id) === entityId;
            return {
                id: row.id,
                entity_type: sourceIsA ? row.entity_b_type : row.entity_a_type,
                entity_id: sourceIsA ? Number(row.entity_b_id) : Number(row.entity_a_id),
                relation: sourceIsA ? row.relation_a_to_b : row.relation_b_to_a,
                relation_label: relationLabel(sourceIsA ? row.relation_a_to_b : row.relation_b_to_a)
            };
        });

        const detalhes = await buscarDetalhesEntidades(tenantId, itens);
        const payload = itens.map((item) => {
            if (item.entity_type === ENTITY_TYPES.JOVEM) {
                const detalhe = formatarDetalheJovem(detalhes.jovensMap.get(Number(item.entity_id)) || {});
                return { ...item, ...detalhe };
            }
            const detalhe = formatarDetalheCasal(detalhes.tiosMap.get(Number(item.entity_id)) || {});
            return { ...item, ...detalhe };
        });
        return res.json(payload);
    } catch (err) {
        console.error('Erro ao listar relações familiares:', err);
        return res.status(500).json({ error: 'Erro ao listar relações familiares.' });
    }
});

router.post('/', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const sourceType = normalizeEntityType(req.body && req.body.source_type);
        const sourceId = Number(req.body && req.body.source_id || 0);
        const targetType = normalizeEntityType(req.body && req.body.target_type);
        const targetId = Number(req.body && req.body.target_id || 0);
        const relation = normalizeRelationType(req.body && req.body.relation);
        if (!sourceType || !sourceId || !targetType || !targetId || !relation) {
            return res.status(400).json({ error: 'Dados da relação inválidos.' });
        }
        if (sourceType === targetType && sourceId === targetId) {
            return res.status(400).json({ error: 'Não é possível vincular o cadastro com ele mesmo.' });
        }
        if (!relationAllowedForPair(sourceType, targetType, relation)) {
            return res.status(400).json({ error: 'Esse parentesco não é permitido para esse tipo de cadastro.' });
        }

        await ensureRelacoesFamiliaresTable();
        const [sourceOk, targetOk] = await Promise.all([
            entityExists(tenantId, sourceType, sourceId),
            entityExists(tenantId, targetType, targetId)
        ]);
        if (!sourceOk || !targetOk) {
            return res.status(404).json({ error: 'Cadastro de origem ou destino não encontrado.' });
        }

        const canonical = canonicalizeRelation({ sourceType, sourceId, targetType, targetId, relation });
        await pool.query(
            `INSERT INTO relacoes_familiares
                (tenant_id, entity_a_type, entity_a_id, entity_b_type, entity_b_id, relation_a_to_b, relation_b_to_a)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                relation_a_to_b = VALUES(relation_a_to_b),
                relation_b_to_a = VALUES(relation_b_to_a)`,
            [
                tenantId,
                canonical.entity_a_type,
                canonical.entity_a_id,
                canonical.entity_b_type,
                canonical.entity_b_id,
                canonical.relation_a_to_b,
                canonical.relation_b_to_a
            ]
        );
        return res.json({ message: 'Relação familiar salva com sucesso.' });
    } catch (err) {
        console.error('Erro ao salvar relação familiar:', err);
        return res.status(500).json({ error: 'Erro ao salvar relação familiar.' });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        await ensureRelacoesFamiliaresTable();
        const [result] = await pool.query('DELETE FROM relacoes_familiares WHERE id = ? AND tenant_id = ?', [req.params.id, tenantId]);
        if (!result.affectedRows) return res.status(404).json({ error: 'Relação não encontrada.' });
        return res.json({ message: 'Relação removida com sucesso.' });
    } catch (err) {
        console.error('Erro ao remover relação familiar:', err);
        return res.status(500).json({ error: 'Erro ao remover relação familiar.' });
    }
});

module.exports = router;
