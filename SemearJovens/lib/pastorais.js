const { pool } = require('../database');

let ensured = false;
let ensurePromise = null;

async function ensurePastoraisTables() {
    if (ensured) return;
    if (ensurePromise) return ensurePromise;
    ensurePromise = (async () => {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS pastorais (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tenant_id INT NOT NULL,
                nome VARCHAR(180) NOT NULL,
                descricao VARCHAR(255) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS pastorais_jovens (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tenant_id INT NOT NULL,
                pastoral_id INT NOT NULL,
                jovem_id INT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        try {
            await pool.query(`
                ALTER TABLE pastorais_jovens
                ADD UNIQUE KEY uniq_pastoral_jovem (tenant_id, pastoral_id, jovem_id)
            `);
        } catch (err) { }
    })();
    try {
        await ensurePromise;
        ensured = true;
    } finally {
        ensurePromise = null;
    }
}

async function ensureContatosPastoralColumn() {
    const [rows] = await pool.query(`
        SELECT COUNT(*) as cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'contatos_telefonicos'
          AND COLUMN_NAME = 'pastoral_id'
    `);
    const exists = !!(rows && rows[0] && rows[0].cnt > 0);
    if (!exists) {
        try {
            await pool.query(`ALTER TABLE contatos_telefonicos ADD COLUMN pastoral_id INT NULL`);
        } catch (err) { }
    }

    try {
        await pool.query(`CREATE INDEX idx_contatos_pastoral ON contatos_telefonicos (tenant_id, pastoral_id)`);
    } catch (err) { }
}

module.exports = {
    ensurePastoraisTables,
    ensureContatosPastoralColumn
};
