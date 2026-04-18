const { pool } = require('../database');

let historicoSnapshotsPromise = null;
let historicoSnapshotsReady = false;
let historicoYoungFkReady = false;
let ejcEncontristasHistoricoReady = false;

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

async function ensureHistoricoEquipesSnapshots() {
    if (historicoSnapshotsReady) return;
    if (historicoSnapshotsPromise) return historicoSnapshotsPromise;

    historicoSnapshotsPromise = (async () => {
        const colunas = [
            ['nome_completo_snapshot', 'VARCHAR(180) NULL'],
            ['telefone_snapshot', 'VARCHAR(30) NULL'],
            ['origem_ejc_tipo_snapshot', 'VARCHAR(30) NULL'],
            ['outro_ejc_numero_snapshot', 'VARCHAR(30) NULL'],
            ['outro_ejc_id_snapshot', 'INT NULL'],
            ['outro_ejc_nome_snapshot', 'VARCHAR(180) NULL'],
            ['outro_ejc_paroquia_snapshot', 'VARCHAR(180) NULL']
        ];

        for (const [nome, definicao] of colunas) {
            if (await hasColumn('historico_equipes', nome)) continue;
            await pool.query(`ALTER TABLE historico_equipes ADD COLUMN ${nome} ${definicao}`);
        }

        historicoSnapshotsReady = true;
    })();

    try {
        await historicoSnapshotsPromise;
    } finally {
        historicoSnapshotsPromise = null;
    }
}

async function ensureHistoricoEquipesYoungFkPreserved() {
    if (historicoYoungFkReady) return;

    const [rows] = await pool.query(`
        SELECT rc.CONSTRAINT_NAME, rc.DELETE_RULE
        FROM information_schema.REFERENTIAL_CONSTRAINTS rc
        JOIN information_schema.KEY_COLUMN_USAGE kcu
          ON kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
         AND kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
         AND kcu.TABLE_NAME = rc.TABLE_NAME
        WHERE rc.CONSTRAINT_SCHEMA = DATABASE()
          AND rc.TABLE_NAME = 'historico_equipes'
          AND kcu.COLUMN_NAME = 'jovem_id'
        LIMIT 1
    `);

    const atual = rows && rows[0] ? rows[0] : null;
    if (atual && String(atual.DELETE_RULE || '').toUpperCase() !== 'SET NULL') {
        await pool.query('ALTER TABLE historico_equipes MODIFY COLUMN jovem_id INT NULL');
        await pool.query(`ALTER TABLE historico_equipes DROP FOREIGN KEY ${atual.CONSTRAINT_NAME}`);
        await pool.query(`
            ALTER TABLE historico_equipes
            ADD CONSTRAINT fk_historico_equipes_jovem
            FOREIGN KEY (jovem_id) REFERENCES jovens(id) ON DELETE SET NULL
        `);
    }

    historicoYoungFkReady = true;
}

async function ensureEjcEncontristasHistoricoTable() {
    if (ejcEncontristasHistoricoReady) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ejc_encontristas_historico (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            ejc_id INT NOT NULL,
            jovem_id INT NULL,
            resposta_id INT NULL,
            nome_completo_snapshot VARCHAR(180) NOT NULL,
            telefone_snapshot VARCHAR(30) NULL,
            circulo_snapshot VARCHAR(80) NULL,
            foi_moita TINYINT(1) NOT NULL DEFAULT 0,
            moita_funcao_snapshot VARCHAR(120) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_ejc_encontristas_hist_ejc (tenant_id, ejc_id),
            KEY idx_ejc_encontristas_hist_jovem (tenant_id, jovem_id),
            CONSTRAINT fk_ejc_encontristas_hist_ejc
                FOREIGN KEY (ejc_id) REFERENCES ejc(id) ON DELETE CASCADE,
            CONSTRAINT fk_ejc_encontristas_hist_jovem
                FOREIGN KEY (jovem_id) REFERENCES jovens(id) ON DELETE SET NULL
        )
    `);
    ejcEncontristasHistoricoReady = true;
}

async function backfillHistoricoEquipesSnapshots({ tenantId = null, jovemId = null, ejcId = null } = {}) {
    await ensureHistoricoEquipesSnapshots();

    const filtros = [
        'he.nome_completo_snapshot IS NULL'
    ];
    const params = [];

    if (tenantId !== null && tenantId !== undefined) {
        filtros.push('he.tenant_id = ?');
        params.push(Number(tenantId));
    }
    if (jovemId !== null && jovemId !== undefined) {
        filtros.push('he.jovem_id = ?');
        params.push(Number(jovemId));
    }
    if (ejcId !== null && ejcId !== undefined) {
        filtros.push('he.ejc_id = ?');
        params.push(Number(ejcId));
    }

    await pool.query(`
        UPDATE historico_equipes he
        JOIN jovens j
          ON j.id = he.jovem_id
         AND j.tenant_id = he.tenant_id
        LEFT JOIN outros_ejcs oe
          ON oe.id = j.outro_ejc_id
         AND oe.tenant_id = j.tenant_id
        SET he.nome_completo_snapshot = COALESCE(he.nome_completo_snapshot, j.nome_completo),
            he.telefone_snapshot = COALESCE(he.telefone_snapshot, j.telefone),
            he.origem_ejc_tipo_snapshot = COALESCE(he.origem_ejc_tipo_snapshot, j.origem_ejc_tipo),
            he.outro_ejc_numero_snapshot = COALESCE(he.outro_ejc_numero_snapshot, j.outro_ejc_numero),
            he.outro_ejc_id_snapshot = COALESCE(he.outro_ejc_id_snapshot, j.outro_ejc_id),
            he.outro_ejc_nome_snapshot = COALESCE(he.outro_ejc_nome_snapshot, oe.nome),
            he.outro_ejc_paroquia_snapshot = COALESCE(he.outro_ejc_paroquia_snapshot, oe.paroquia)
        WHERE ${filtros.join(' AND ')}
    `, params);
}

module.exports = {
    ensureHistoricoEquipesSnapshots,
    ensureHistoricoEquipesYoungFkPreserved,
    ensureEjcEncontristasHistoricoTable,
    backfillHistoricoEquipesSnapshots
};
