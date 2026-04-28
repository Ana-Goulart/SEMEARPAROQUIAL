const {
    blindIndex,
    decryptValue,
    encryptValue
} = require('./fieldEncryption');

async function hasColumn(pool, tableName, columnName) {
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
    `, [tableName, columnName]);
    return !!(rows && rows[0] && rows[0].cnt > 0);
}

function normalizeTrimmedText(value) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text || null;
}

function normalizePhoneDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function normalizeEmailValue(value) {
    return String(value || '').trim().toLowerCase();
}

function encryptJovemPhone(value) {
    const normalized = normalizeTrimmedText(value);
    return normalized ? encryptValue(normalized, 'lista-mestre:telefone') : null;
}

function decryptJovemPhone(value) {
    return normalizeTrimmedText(decryptValue(value, 'lista-mestre:telefone'));
}

function jovemPhoneHash(value) {
    const normalized = normalizePhoneDigits(value);
    return normalized ? blindIndex(normalized, 'lista-mestre:telefone') : null;
}

function encryptJovemEmail(value) {
    const normalized = normalizeTrimmedText(value);
    return normalized ? encryptValue(normalized, 'lista-mestre:email') : null;
}

function decryptJovemEmail(value) {
    return normalizeTrimmedText(decryptValue(value, 'lista-mestre:email'));
}

function jovemEmailHash(value) {
    const normalized = normalizeEmailValue(value);
    return normalized ? blindIndex(normalized, 'lista-mestre:email') : null;
}

function encryptJovemSensitiveText(value, purpose) {
    const normalized = normalizeTrimmedText(value);
    return normalized ? encryptValue(normalized, `lista-mestre:${purpose}`) : null;
}

function decryptJovemSensitiveText(value, purpose) {
    return normalizeTrimmedText(decryptValue(value, `lista-mestre:${purpose}`));
}

function decryptJovemRecord(record) {
    if (!record || typeof record !== 'object') return record;
    const item = { ...record };
    if (Object.prototype.hasOwnProperty.call(item, 'telefone')) item.telefone = decryptJovemPhone(item.telefone);
    if (Object.prototype.hasOwnProperty.call(item, 'email')) item.email = decryptJovemEmail(item.email);
    if (Object.prototype.hasOwnProperty.call(item, 'conjuge_telefone')) item.conjuge_telefone = decryptJovemPhone(item.conjuge_telefone);
    if (Object.prototype.hasOwnProperty.call(item, 'qual_deficiencia')) item.qual_deficiencia = decryptJovemSensitiveText(item.qual_deficiencia, 'qual-deficiencia');
    if (Object.prototype.hasOwnProperty.call(item, 'detalhes_restricao')) item.detalhes_restricao = decryptJovemSensitiveText(item.detalhes_restricao, 'detalhes-restricao');
    return item;
}

async function ensureJovensSensitiveColumns(pool) {
    try {
        await pool.query('ALTER TABLE jovens ADD COLUMN email VARCHAR(180) NULL AFTER telefone');
    } catch (err) {
        if (!err || err.code !== 'ER_DUP_FIELDNAME') throw err;
    }

    const alterStatements = [
        'ALTER TABLE jovens MODIFY COLUMN telefone TEXT NULL',
        'ALTER TABLE jovens MODIFY COLUMN email TEXT NULL',
        'ALTER TABLE jovens MODIFY COLUMN qual_deficiencia TEXT NULL',
        'ALTER TABLE jovens MODIFY COLUMN detalhes_restricao TEXT NULL'
    ];
    if (await hasColumn(pool, 'jovens', 'conjuge_telefone')) {
        alterStatements.push('ALTER TABLE jovens MODIFY COLUMN conjuge_telefone TEXT NULL');
    }
    for (const sql of alterStatements) {
        try {
            await pool.query(sql);
        } catch (_) { }
    }

    const statements = [
        'ALTER TABLE jovens ADD COLUMN telefone_hash CHAR(64) NULL AFTER telefone',
        'ALTER TABLE jovens ADD COLUMN email_hash CHAR(64) NULL AFTER email',
        'ALTER TABLE jovens ADD KEY idx_jovens_tenant_telefone_hash (tenant_id, telefone_hash)',
        'ALTER TABLE jovens ADD KEY idx_jovens_tenant_email_hash (tenant_id, email_hash)'
    ];
    if (await hasColumn(pool, 'jovens', 'conjuge_telefone')) {
        statements.push('ALTER TABLE jovens ADD COLUMN conjuge_telefone_hash CHAR(64) NULL AFTER conjuge_telefone');
        statements.push('ALTER TABLE jovens ADD KEY idx_jovens_tenant_conjuge_telefone_hash (tenant_id, conjuge_telefone_hash)');
    }
    for (const sql of statements) {
        try {
            await pool.query(sql);
        } catch (err) {
            if (!err || (err.code !== 'ER_DUP_FIELDNAME' && err.code !== 'ER_DUP_KEYNAME')) throw err;
        }
    }
}

module.exports = {
    decryptJovemRecord,
    decryptJovemPhone,
    encryptJovemEmail,
    encryptJovemPhone,
    encryptJovemSensitiveText,
    ensureJovensSensitiveColumns,
    jovemEmailHash,
    jovemPhoneHash,
    normalizePhoneDigits
};
