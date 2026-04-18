const { pool } = require('../database');

let ensured = false;
let ensurePromise = null;

async function hasTable(tableName) {
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
    `, [tableName]);
    return !!(rows && rows[0] && rows[0].cnt > 0);
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

async function runAlterIgnoreDuplicate(sql) {
    try {
        await pool.query(sql);
    } catch (err) {
        if (err && (err.code === 'ER_DUP_FIELDNAME' || err.code === 'ER_DUP_KEYNAME')) return;
        throw err;
    }
}

async function ensureTenantColumn(tableName) {
    if (!await hasTable(tableName)) return;
    if (!await hasColumn(tableName, 'tenant_id')) {
        await runAlterIgnoreDuplicate(`ALTER TABLE ${tableName} ADD COLUMN tenant_id INT NULL`);
    }
    await pool.query(`UPDATE ${tableName} SET tenant_id = 1 WHERE tenant_id IS NULL`);
    await runAlterIgnoreDuplicate(`ALTER TABLE ${tableName} MODIFY COLUMN tenant_id INT NOT NULL`);
    await runAlterIgnoreDuplicate(`ALTER TABLE ${tableName} ADD KEY idx_${tableName}_tenant (tenant_id)`);
}

async function ensureTenantIsolation() {
    if (ensured) return;
    if (ensurePromise) return ensurePromise;

    ensurePromise = (async () => {
        const tables = [
            'ejc',
            'outros_ejcs',
            'jovens',
            'historico_equipes',
            'jovens_comissoes',
            'jovens_observacoes',
            'equipes',
            'equipes_ejc',
            'equipes_funcoes',
            'equipes_papeis',
            'equipes_funcoes_padrao',
            'montagens',
            'montagem_membros',
            'formularios_pastas',
            'formularios_itens',
            'formularios_presencas',
            'financeiro_movimentacoes',
            'circulos',
            'coordenacoes',
            'coordenacoes_pastas',
            'coordenacoes_membros',
            'calendario_eventos',
            'calendario_eventos_excecoes',
            'calendario_eventos_padrao',
            'calendario_pastas',
            'moita_funcoes',
            'moita_reservas'
        ];
        for (const t of tables) {
            await ensureTenantColumn(t);
        }
        ensured = true;
    })();

    try {
        await ensurePromise;
    } finally {
        ensurePromise = null;
    }
}

function getTenantId(req) {
    const id = req && req.user && req.user.tenant_id ? Number(req.user.tenant_id) : 0;
    return Number.isInteger(id) && id > 0 ? id : 1;
}

module.exports = {
    ensureTenantIsolation,
    getTenantId
};
