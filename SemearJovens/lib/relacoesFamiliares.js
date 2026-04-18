const { pool } = require('../database');

const ENTITY_TYPES = Object.freeze({
    JOVEM: 'JOVEM',
    TIO_CASAL: 'TIO_CASAL'
});

const RELATION_TYPES = Object.freeze({
    IRMAO: 'IRMAO',
    PRIMO: 'PRIMO',
    NAMORADO: 'NAMORADO',
    NOIVO: 'NOIVO',
    TIO: 'TIO',
    SOBRINHO: 'SOBRINHO',
    MAE_PAI: 'MAE_PAI',
    FILHO: 'FILHO'
});

const TYPE_ORDER = Object.freeze({
    [ENTITY_TYPES.JOVEM]: 1,
    [ENTITY_TYPES.TIO_CASAL]: 2
});

const LABELS = Object.freeze({
    [RELATION_TYPES.IRMAO]: 'Irmão(ã)',
    [RELATION_TYPES.PRIMO]: 'Primo(a)',
    [RELATION_TYPES.NAMORADO]: 'Namorado(a)',
    [RELATION_TYPES.NOIVO]: 'Noivo(a)',
    [RELATION_TYPES.TIO]: 'Tio(a)',
    [RELATION_TYPES.SOBRINHO]: 'Sobrinho(a)',
    [RELATION_TYPES.MAE_PAI]: 'Mãe/Pai',
    [RELATION_TYPES.FILHO]: 'Filho(a)'
});

function normalizeEntityType(value) {
    const type = String(value || '').trim().toUpperCase();
    if (type === ENTITY_TYPES.JOVEM) return ENTITY_TYPES.JOVEM;
    if (type === ENTITY_TYPES.TIO_CASAL) return ENTITY_TYPES.TIO_CASAL;
    return null;
}

function normalizeRelationType(value) {
    const relation = String(value || '').trim().toUpperCase();
    return RELATION_TYPES[relation] || null;
}

function relationLabel(relation) {
    return LABELS[relation] || relation || '-';
}

function getReverseRelation(relation) {
    switch (relation) {
        case RELATION_TYPES.IRMAO: return RELATION_TYPES.IRMAO;
        case RELATION_TYPES.PRIMO: return RELATION_TYPES.PRIMO;
        case RELATION_TYPES.NAMORADO: return RELATION_TYPES.NAMORADO;
        case RELATION_TYPES.NOIVO: return RELATION_TYPES.NOIVO;
        case RELATION_TYPES.TIO: return RELATION_TYPES.SOBRINHO;
        case RELATION_TYPES.SOBRINHO: return RELATION_TYPES.TIO;
        case RELATION_TYPES.MAE_PAI: return RELATION_TYPES.FILHO;
        case RELATION_TYPES.FILHO: return RELATION_TYPES.MAE_PAI;
        default: return null;
    }
}

function getAllowedRelationsForSourceType(sourceType) {
    if (sourceType === ENTITY_TYPES.TIO_CASAL) {
        return [
            RELATION_TYPES.IRMAO,
            RELATION_TYPES.PRIMO,
            RELATION_TYPES.NAMORADO,
            RELATION_TYPES.NOIVO,
            RELATION_TYPES.TIO,
            RELATION_TYPES.MAE_PAI
        ];
    }
    if (sourceType === ENTITY_TYPES.JOVEM) {
        return [
            RELATION_TYPES.IRMAO,
            RELATION_TYPES.PRIMO,
            RELATION_TYPES.NAMORADO,
            RELATION_TYPES.NOIVO,
            RELATION_TYPES.TIO,
            RELATION_TYPES.FILHO
        ];
    }
    return [];
}

function relationAllowedForPair(sourceType, targetType, relation) {
    if (!getAllowedRelationsForSourceType(sourceType).includes(relation)) return false;
    if (relation === RELATION_TYPES.MAE_PAI) return sourceType === ENTITY_TYPES.TIO_CASAL && targetType === ENTITY_TYPES.JOVEM;
    if (relation === RELATION_TYPES.FILHO) return sourceType === ENTITY_TYPES.JOVEM && targetType === ENTITY_TYPES.TIO_CASAL;
    return true;
}

function compareEntities(typeA, idA, typeB, idB) {
    const orderA = TYPE_ORDER[typeA] || 99;
    const orderB = TYPE_ORDER[typeB] || 99;
    if (orderA !== orderB) return orderA - orderB;
    return Number(idA || 0) - Number(idB || 0);
}

function canonicalizeRelation({ sourceType, sourceId, targetType, targetId, relation }) {
    const reverse = getReverseRelation(relation);
    const cmp = compareEntities(sourceType, sourceId, targetType, targetId);
    if (cmp <= 0) {
        return {
            entity_a_type: sourceType,
            entity_a_id: Number(sourceId),
            entity_b_type: targetType,
            entity_b_id: Number(targetId),
            relation_a_to_b: relation,
            relation_b_to_a: reverse
        };
    }
    return {
        entity_a_type: targetType,
        entity_a_id: Number(targetId),
        entity_b_type: sourceType,
        entity_b_id: Number(sourceId),
        relation_a_to_b: reverse,
        relation_b_to_a: relation
    };
}

async function ensureRelacoesFamiliaresTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS relacoes_familiares (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            entity_a_type VARCHAR(20) NOT NULL,
            entity_a_id INT NOT NULL,
            entity_b_type VARCHAR(20) NOT NULL,
            entity_b_id INT NOT NULL,
            relation_a_to_b VARCHAR(20) NOT NULL,
            relation_b_to_a VARCHAR(20) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_relacao_familiar (tenant_id, entity_a_type, entity_a_id, entity_b_type, entity_b_id),
            KEY idx_relacao_familiar_a (tenant_id, entity_a_type, entity_a_id),
            KEY idx_relacao_familiar_b (tenant_id, entity_b_type, entity_b_id)
        )
    `);
}

async function entityExists(tenantId, entityType, entityId) {
    if (entityType === ENTITY_TYPES.JOVEM) {
        const [rows] = await pool.query('SELECT id FROM jovens WHERE id = ? AND tenant_id = ? LIMIT 1', [entityId, tenantId]);
        return !!(rows && rows.length);
    }
    if (entityType === ENTITY_TYPES.TIO_CASAL) {
        const [rows] = await pool.query('SELECT id FROM tios_casais WHERE id = ? AND tenant_id = ? LIMIT 1', [entityId, tenantId]);
        return !!(rows && rows.length);
    }
    return false;
}

async function buildYoungFamilyMap(tenantId, jovemIds) {
    const ids = Array.from(new Set((jovemIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
    const map = new Map();
    ids.forEach((id) => map.set(id, new Set()));
    if (!ids.length) return map;

    await ensureRelacoesFamiliaresTable();
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await pool.query(
        `SELECT entity_a_id, entity_b_id
         FROM relacoes_familiares
         WHERE tenant_id = ?
           AND entity_a_type = 'JOVEM'
           AND entity_b_type = 'JOVEM'
           AND (entity_a_id IN (${placeholders}) OR entity_b_id IN (${placeholders}))`,
        [tenantId, ...ids, ...ids]
    );

    for (const row of (rows || [])) {
        const a = Number(row.entity_a_id) || 0;
        const b = Number(row.entity_b_id) || 0;
        if (a > 0) {
            if (!map.has(a)) map.set(a, new Set());
            map.get(a).add(b);
        }
        if (b > 0) {
            if (!map.has(b)) map.set(b, new Set());
            map.get(b).add(a);
        }
    }

    return map;
}

module.exports = {
    ENTITY_TYPES,
    RELATION_TYPES,
    ensureRelacoesFamiliaresTable,
    normalizeEntityType,
    normalizeRelationType,
    relationLabel,
    relationAllowedForPair,
    canonicalizeRelation,
    entityExists,
    getAllowedRelationsForSourceType,
    buildYoungFamilyMap
};
