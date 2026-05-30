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

function encryptTioPhone(value) {
    const normalized = normalizeTrimmedText(value);
    return normalized ? encryptValue(normalized, 'tios:telefone') : null;
}

function decryptTioPhone(value) {
    return normalizeTrimmedText(decryptValue(value, 'tios:telefone'));
}

function tioPhoneHash(value) {
    const normalized = normalizePhoneDigits(value);
    return normalized ? blindIndex(normalized, 'tios:telefone') : null;
}

function normalizeCpfDigits(value) {
    return String(value || '').replace(/\D/g, '').slice(0, 11);
}

function formatCpf(value) {
    const digits = normalizeCpfDigits(value);
    if (!digits) return '';
    return digits.length === 11 ? `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}` : digits;
}

function encryptTioCpf(value) {
    const formatted = formatCpf(value);
    return formatted && normalizeCpfDigits(formatted).length === 11 ? encryptValue(formatted, 'tios:cpf') : null;
}

function decryptTioCpf(value) {
    return normalizeTrimmedText(decryptValue(value, 'tios:cpf'));
}

function tioCpfHash(value) {
    const normalized = normalizeCpfDigits(value);
    return normalized.length === 11 ? blindIndex(normalized, 'tios:cpf') : null;
}

function encryptTioSensitiveText(value, purpose) {
    const normalized = normalizeTrimmedText(value);
    return normalized ? encryptValue(normalized, `tios:${purpose}`) : null;
}

function decryptTioSensitiveText(value, purpose) {
    return normalizeTrimmedText(decryptValue(value, `tios:${purpose}`));
}

function decryptTiosCasal(record) {
    if (!record || typeof record !== 'object') return record;
    const item = { ...record };
    if (Object.prototype.hasOwnProperty.call(item, 'telefone_tio')) item.telefone_tio = decryptTioPhone(item.telefone_tio);
    if (Object.prototype.hasOwnProperty.call(item, 'telefone_tia')) item.telefone_tia = decryptTioPhone(item.telefone_tia);
    if (Object.prototype.hasOwnProperty.call(item, 'cpf_tio')) item.cpf_tio = decryptTioCpf(item.cpf_tio);
    if (Object.prototype.hasOwnProperty.call(item, 'cpf_tia')) item.cpf_tia = decryptTioCpf(item.cpf_tia);
    if (Object.prototype.hasOwnProperty.call(item, 'detalhes_restricao_tio')) item.detalhes_restricao_tio = decryptTioSensitiveText(item.detalhes_restricao_tio, 'detalhes-restricao-tio');
    if (Object.prototype.hasOwnProperty.call(item, 'qual_deficiencia_tio')) item.qual_deficiencia_tio = decryptTioSensitiveText(item.qual_deficiencia_tio, 'qual-deficiencia-tio');
    if (Object.prototype.hasOwnProperty.call(item, 'detalhes_restricao_tia')) item.detalhes_restricao_tia = decryptTioSensitiveText(item.detalhes_restricao_tia, 'detalhes-restricao-tia');
    if (Object.prototype.hasOwnProperty.call(item, 'qual_deficiencia_tia')) item.qual_deficiencia_tia = decryptTioSensitiveText(item.qual_deficiencia_tia, 'qual-deficiencia-tia');
    return item;
}

async function ensureTiosSensitiveColumns(pool) {
    const alterStatements = [
        'ALTER TABLE tios_casais MODIFY COLUMN telefone_tio TEXT NULL',
        'ALTER TABLE tios_casais MODIFY COLUMN telefone_tia TEXT NULL',
        'ALTER TABLE tios_casais MODIFY COLUMN detalhes_restricao_tio TEXT NULL',
        'ALTER TABLE tios_casais MODIFY COLUMN qual_deficiencia_tio TEXT NULL',
        'ALTER TABLE tios_casais MODIFY COLUMN detalhes_restricao_tia TEXT NULL',
        'ALTER TABLE tios_casais MODIFY COLUMN qual_deficiencia_tia TEXT NULL'
    ];
    for (const sql of alterStatements) {
        try {
            await pool.query(sql);
        } catch (_) { }
    }

    const statements = [
        'ALTER TABLE tios_casais ADD COLUMN telefone_tio_hash CHAR(64) NULL AFTER telefone_tio',
        'ALTER TABLE tios_casais ADD COLUMN telefone_tia_hash CHAR(64) NULL AFTER telefone_tia',
        'ALTER TABLE tios_casais ADD KEY idx_tios_casais_tenant_telefone_tio_hash (tenant_id, telefone_tio_hash)',
        'ALTER TABLE tios_casais ADD KEY idx_tios_casais_tenant_telefone_tia_hash (tenant_id, telefone_tia_hash)'
    ];
    for (const sql of statements) {
        try {
            await pool.query(sql);
        } catch (err) {
            if (!err || (err.code !== 'ER_DUP_FIELDNAME' && err.code !== 'ER_DUP_KEYNAME')) throw err;
        }
    }
}

module.exports = {
    decryptTioPhone,
    decryptTioCpf,
    decryptTiosCasal,
    encryptTioCpf,
    encryptTioPhone,
    encryptTioSensitiveText,
    ensureTiosSensitiveColumns,
    tioCpfHash,
    tioPhoneHash
};
