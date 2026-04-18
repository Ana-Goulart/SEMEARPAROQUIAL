const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { getTenantId } = require('../lib/tenantIsolation');
const { ensurePastoraisTables } = require('../lib/pastorais');
const {
    ensureHistoricoEquipesSnapshots,
    ensureHistoricoEquipesYoungFkPreserved,
    ensureEjcEncontristasHistoricoTable,
    backfillHistoricoEquipesSnapshots
} = require('../lib/ejcHistorySnapshots');

const uploadDirAbs = path.join(__dirname, '..', 'public', 'uploads', 'fotos_jovens');

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        if (!fs.existsSync(uploadDirAbs)) {
            fs.mkdirSync(uploadDirAbs, { recursive: true });
        }
        cb(null, uploadDirAbs);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_'));
    }
});
const upload = multer({ storage: storage });

let hasSubfuncaoColumnCache = null;
let hasHistoricoCreatedAtColumnCache = null;
let hasEhMusicoColumnCache = null;
let hasInstrumentosMusicaisColumnCache = null;
let hasSexoColumnCache = null;
let hasEmailColumnCache = null;
let hasApelidoColumnCache = null;
let hasEnderecoColumnsCache = null;
let hasListaMestreAtivoColumnCache = null;
let hasNaoServeEjcColumnsCache = null;
let hasEquipeSaudeColumnCache = null;
let ensureCadastroOrigemPromise = null;
let ensureTiosTablesPromise = null;
let ensureTiosVinculosPromise = null;
const NORMALIZED_PHONE_SQL = "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(COALESCE(%FIELD%, '')), ' ', ''), '(', ''), ')', ''), '-', ''), '+', '')";

function normalizedPhoneExpr(fieldName) {
    return NORMALIZED_PHONE_SQL.replace('%FIELD%', fieldName);
}

function mapearPapelPorNomeFuncao(nomeFuncao) {
    const funcaoLower = String(nomeFuncao || '').trim().toLowerCase();
    if (funcaoLower.includes('tio') || funcaoLower.includes('tia')) return 'Tio';
    if (
        funcaoLower.includes('coordenador')
        || funcaoLower.includes('cordenador')
        || funcaoLower.includes('coord')
    ) return 'Coordenador';
    return 'Membro';
}

function montarEtiquetaEdicao(numeroEjc) {
    return `${numeroEjc}º EJC (Montagem)`;
}

async function hasSubfuncaoColumn() {
    if (hasSubfuncaoColumnCache !== null) return hasSubfuncaoColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) as cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'historico_equipes'
          AND COLUMN_NAME = 'subfuncao'
    `);
    hasSubfuncaoColumnCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasSubfuncaoColumnCache;
}

async function hasHistoricoCreatedAtColumn() {
    if (hasHistoricoCreatedAtColumnCache !== null) return hasHistoricoCreatedAtColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) as cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'historico_equipes'
          AND COLUMN_NAME = 'created_at'
    `);
    hasHistoricoCreatedAtColumnCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasHistoricoCreatedAtColumnCache;
}

async function hasEhMusicoColumn() {
    if (hasEhMusicoColumnCache !== null) return hasEhMusicoColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) as cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'jovens'
          AND COLUMN_NAME = 'eh_musico'
    `);
    hasEhMusicoColumnCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasEhMusicoColumnCache;
}

async function hasInstrumentosMusicaisColumn() {
    if (hasInstrumentosMusicaisColumnCache !== null) return hasInstrumentosMusicaisColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) as cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'jovens'
          AND COLUMN_NAME = 'instrumentos_musicais'
    `);
    hasInstrumentosMusicaisColumnCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasInstrumentosMusicaisColumnCache;
}

async function hasSexoColumn() {
    if (hasSexoColumnCache !== null) return hasSexoColumnCache;

    const [rows] = await pool.query(`
        SELECT COUNT(*) as cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'jovens'
          AND COLUMN_NAME = 'sexo'
    `);
    const existe = !!(rows && rows[0] && rows[0].cnt > 0);
    if (existe) {
        hasSexoColumnCache = true;
        return true;
    }

    try {
        await pool.query("ALTER TABLE jovens ADD COLUMN sexo ENUM('Feminino','Masculino') NULL");
    } catch (e) { }

    const [rows2] = await pool.query(`
        SELECT COUNT(*) as cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'jovens'
          AND COLUMN_NAME = 'sexo'
    `);
    hasSexoColumnCache = !!(rows2 && rows2[0] && rows2[0].cnt > 0);
    return hasSexoColumnCache;
}

async function hasEmailColumn() {
    if (hasEmailColumnCache !== null) return hasEmailColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) as cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'jovens'
          AND COLUMN_NAME = 'email'
    `);
    hasEmailColumnCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasEmailColumnCache;
}

async function hasApelidoColumn() {
    if (hasApelidoColumnCache !== null) return hasApelidoColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) as cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'jovens'
          AND COLUMN_NAME = 'apelido'
    `);
    hasApelidoColumnCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasApelidoColumnCache;
}

async function hasListaMestreAtivoColumn() {
    if (hasListaMestreAtivoColumnCache !== null) return hasListaMestreAtivoColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) as cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'jovens'
          AND COLUMN_NAME = 'lista_mestre_ativo'
    `);
    hasListaMestreAtivoColumnCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasListaMestreAtivoColumnCache;
}

async function ensureEnderecoColumns() {
    if (hasEnderecoColumnsCache !== null) return hasEnderecoColumnsCache;
    const checks = await Promise.all([
        hasColumn('jovens', 'endereco_rua'),
        hasColumn('jovens', 'endereco_numero'),
        hasColumn('jovens', 'endereco_bairro'),
        hasColumn('jovens', 'endereco_cidade'),
        hasColumn('jovens', 'endereco_cep')
    ]);
    if (checks.every(Boolean)) {
        hasEnderecoColumnsCache = true;
        return true;
    }
    try {
        if (!checks[0]) await pool.query("ALTER TABLE jovens ADD COLUMN endereco_rua VARCHAR(180) NULL");
        if (!checks[1]) await pool.query("ALTER TABLE jovens ADD COLUMN endereco_numero VARCHAR(30) NULL");
        if (!checks[2]) await pool.query("ALTER TABLE jovens ADD COLUMN endereco_bairro VARCHAR(120) NULL");
        if (!checks[3]) await pool.query("ALTER TABLE jovens ADD COLUMN endereco_cidade VARCHAR(120) NULL");
        if (!checks[4]) await pool.query("ALTER TABLE jovens ADD COLUMN endereco_cep VARCHAR(12) NULL");
    } catch (e) { }
    hasEnderecoColumnsCache = true;
    return true;
}

async function ensureEmailColumn() {
    const existe = await hasEmailColumn();
    if (existe) return;
    try {
        await pool.query("ALTER TABLE jovens ADD COLUMN email VARCHAR(180) NULL AFTER telefone");
    } catch (err) {
        if (!err || err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
    hasEmailColumnCache = true;
}

async function ensureApelidoColumn() {
    const existe = await hasApelidoColumn();
    if (existe) return;
    try {
        await pool.query("ALTER TABLE jovens ADD COLUMN apelido VARCHAR(120) NULL AFTER nome_completo");
    } catch (err) {
        if (!err || err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
    hasApelidoColumnCache = true;
}

async function ensureListaMestreAtivoColumn() {
    const existe = await hasListaMestreAtivoColumn();
    if (existe) return;
    try {
        await pool.query("ALTER TABLE jovens ADD COLUMN lista_mestre_ativo TINYINT(1) NOT NULL DEFAULT 1 AFTER montagem_ejc_id");
    } catch (err) {
        if (!err || err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
    hasListaMestreAtivoColumnCache = true;
}

async function hasEquipeSaudeColumn() {
    if (hasEquipeSaudeColumnCache !== null) return hasEquipeSaudeColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) as cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'jovens'
          AND COLUMN_NAME = 'equipe_saude'
    `);
    hasEquipeSaudeColumnCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasEquipeSaudeColumnCache;
}

async function ensureEquipeSaudeColumn() {
    const existe = await hasEquipeSaudeColumn();
    if (existe) return;
    try {
        await pool.query("ALTER TABLE jovens ADD COLUMN equipe_saude TINYINT(1) NOT NULL DEFAULT 0 AFTER eh_musico");
    } catch (err) {
        if (!err || err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
    hasEquipeSaudeColumnCache = true;
}

async function hasColumn(tableName, columnName) {
    const [rows] = await pool.query(`
        SELECT COUNT(*) as cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
    `, [tableName, columnName]);
    return !!(rows && rows[0] && rows[0].cnt > 0);
}

async function ensureNaoServeEjcColumns() {
    if (hasNaoServeEjcColumnsCache !== null) return hasNaoServeEjcColumnsCache;
    const [hasFlag, hasMotivo] = await Promise.all([
        hasColumn('jovens', 'nao_serve_ejc'),
        hasColumn('jovens', 'motivo_nao_serve_ejc')
    ]);
    if (!hasFlag) {
        try {
            await pool.query("ALTER TABLE jovens ADD COLUMN nao_serve_ejc TINYINT(1) NOT NULL DEFAULT 0 AFTER observacoes_extras");
        } catch (e) { }
    }
    if (!hasMotivo) {
        try {
            await pool.query("ALTER TABLE jovens ADD COLUMN motivo_nao_serve_ejc TEXT NULL AFTER nao_serve_ejc");
        } catch (e) { }
    }
    hasNaoServeEjcColumnsCache = true;
    return true;
}

async function resolveNumeroEjcFezInput({ tenantId, value }) {
    if (value === null || value === undefined || value === '') {
        return { numero_ejc_fez: null, montagem_ejc_id: null };
    }
    const txt = String(value).trim();
    if (!txt) return { numero_ejc_fez: null, montagem_ejc_id: null };
    if (txt.startsWith('montagem:')) {
        const montagemId = Number(txt.split(':')[1] || 0);
        if (!Number.isInteger(montagemId) || montagemId <= 0) {
            return { numero_ejc_fez: null, montagem_ejc_id: null };
        }
        const [[montagem]] = await pool.query(
            `SELECT id
             FROM montagens
             WHERE id = ? AND tenant_id = ?
             LIMIT 1`,
            [montagemId, tenantId]
        );
        return {
            numero_ejc_fez: null,
            montagem_ejc_id: montagem && montagem.id ? Number(montagem.id) : null
        };
    }
    const numeric = Number(txt);
    return {
        numero_ejc_fez: Number.isFinite(numeric) && numeric > 0 ? numeric : null,
        montagem_ejc_id: null
    };
}

async function hasTable(tableName) {
    const [rows] = await pool.query(`
        SELECT COUNT(*) as cnt
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
    `, [tableName]);
    return !!(rows && rows[0] && rows[0].cnt > 0);
}

function normalizePhoneDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function normalizeEmailValue(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeInstagramValue(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/^@+/, '');
}

async function validarDuplicidadeJovemListaMestre({
    tenantId,
    telefone,
    email,
    instagram,
    excludeId = null,
    connection = pool
}) {
    const normalizedPhone = normalizePhoneDigits(telefone);
    const normalizedEmail = normalizeEmailValue(email);
    const normalizedInstagram = normalizeInstagramValue(instagram);

    if (normalizedPhone) {
        const params = [tenantId, normalizedPhone];
        let sql = `
            SELECT id, nome_completo, telefone
            FROM jovens
            WHERE tenant_id = ?
              AND ${normalizedPhoneExpr('telefone')} = ?
        `;
        if (excludeId) {
            sql += ' AND id <> ?';
            params.push(Number(excludeId));
        }
        sql += ' LIMIT 1';
        const [rows] = await connection.query(sql, params);
        if (rows && rows.length) {
            return {
                campo: 'telefone',
                error: `Já existe um jovem com este telefone neste EJC: ${rows[0].nome_completo || 'registro existente'}.`
            };
        }
    }

    if (normalizedEmail) {
        const params = [tenantId, normalizedEmail];
        let sql = `
            SELECT id, nome_completo, email
            FROM jovens
            WHERE tenant_id = ?
              AND LOWER(TRIM(COALESCE(email, ''))) = ?
        `;
        if (excludeId) {
            sql += ' AND id <> ?';
            params.push(Number(excludeId));
        }
        sql += ' LIMIT 1';
        const [rows] = await connection.query(sql, params);
        if (rows && rows.length) {
            return {
                campo: 'email',
                error: `Já existe um jovem com este e-mail neste EJC: ${rows[0].nome_completo || 'registro existente'}.`
            };
        }
    }

    if (normalizedInstagram) {
        const params = [tenantId, normalizedInstagram];
        let sql = `
            SELECT id, nome_completo, instagram
            FROM jovens
            WHERE tenant_id = ?
              AND REPLACE(LOWER(TRIM(COALESCE(instagram, ''))), '@', '') = ?
        `;
        if (excludeId) {
            sql += ' AND id <> ?';
            params.push(Number(excludeId));
        }
        sql += ' LIMIT 1';
        const [rows] = await connection.query(sql, params);
        if (rows && rows.length) {
            return {
                campo: 'instagram',
                error: `Já existe um jovem com este Instagram neste EJC: ${rows[0].nome_completo || 'registro existente'}.`
            };
        }
    }

    return null;
}

router.post('/validar-duplicidade', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const duplicidade = await validarDuplicidadeJovemListaMestre({
            tenantId,
            telefone: req.body && req.body.telefone,
            email: req.body && req.body.email,
            instagram: req.body && req.body.instagram,
            excludeId: req.body && req.body.excludeId ? Number(req.body.excludeId) : null
        });

        if (duplicidade) {
            return res.status(409).json({
                ok: false,
                campo: duplicidade.campo,
                error: duplicidade.error
            });
        }

        return res.json({ ok: true });
    } catch (err) {
        console.error('Erro ao validar duplicidade da lista mestre:', err);
        return res.status(500).json({ error: 'Erro ao validar duplicidade.' });
    }
});

async function vincularPresencasOutroEjcSemCadastro({
    tenantId,
    jovemId,
    nomeAtual,
    telefoneAtual,
    outroEjcIdAtual,
    nomeOriginal,
    telefoneOriginal,
    outroEjcIdOriginal
}) {
    if (!tenantId || !jovemId) return;
    if (!await hasTable('formularios_presencas')) return;

    const possuiOutroEjcVinculado = [outroEjcIdAtual, outroEjcIdOriginal]
        .some((v) => Number.isInteger(Number(v)) && Number(v) > 0);
    if (!possuiOutroEjcVinculado) return;

    const [hasNome, hasTelefone, hasOutroEjcId, hasOrigemJaFez] = await Promise.all([
        hasColumn('formularios_presencas', 'nome_completo'),
        hasColumn('formularios_presencas', 'telefone'),
        hasColumn('formularios_presencas', 'outro_ejc_id'),
        hasColumn('formularios_presencas', 'origem_ja_fez')
    ]);
    if (!hasNome || !hasTelefone) return;

    const nomes = Array.from(new Set(
        [nomeAtual, nomeOriginal]
            .map((v) => String(v || '').trim().toLowerCase())
            .filter(Boolean)
    ));
    const telefones = Array.from(new Set(
        [telefoneAtual, telefoneOriginal]
            .map((v) => normalizePhoneDigits(v))
            .filter(Boolean)
    ));
    const outrosEjcs = Array.from(new Set(
        [outroEjcIdAtual, outroEjcIdOriginal]
            .map((v) => Number(v))
            .filter((v) => Number.isInteger(v) && v > 0)
    ));

    if (!nomes.length || !telefones.length) return;

    const filtros = [
        'tenant_id = ?',
        'COALESCE(jovem_id, 0) = 0',
        `LOWER(TRIM(COALESCE(nome_completo, ''))) IN (${nomes.map(() => '?').join(', ')})`,
        `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(COALESCE(telefone, '')), ' ', ''), '(', ''), ')', ''), '-', ''), '+', '') IN (${telefones.map(() => '?').join(', ')})`
    ];
    const params = [tenantId, ...nomes, ...telefones];

    if (hasOutroEjcId && outrosEjcs.length) {
        filtros.push(`(COALESCE(outro_ejc_id, 0) IN (${outrosEjcs.map(() => '?').join(', ')}) OR outro_ejc_id IS NULL)`);
        params.push(...outrosEjcs);
    }
    if (hasOrigemJaFez) {
        filtros.push(`(origem_ja_fez = 'OUTRO_EJC' OR ${hasOutroEjcId ? 'outro_ejc_id IS NOT NULL' : '1 = 1'})`);
    }

    const sets = ['jovem_id = ?', 'nome_completo = ?', 'telefone = ?'];
    const updateParams = [jovemId, String(nomeAtual || '').trim() || null, String(telefoneAtual || '').trim() || null];
    if (hasOutroEjcId) {
        sets.push('outro_ejc_id = ?');
        updateParams.push(Number(outroEjcIdAtual) || null);
    }

    await pool.query(
        `UPDATE formularios_presencas
         SET ${sets.join(', ')}
         WHERE ${filtros.join(' AND ')}`,
        [...updateParams, ...params]
    );
}

async function ensureTiosTables() {
    if (ensureTiosTablesPromise) return ensureTiosTablesPromise;
    ensureTiosTablesPromise = (async () => {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tios_ecc (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tenant_id INT NOT NULL,
                numero VARCHAR(30) NOT NULL,
                tipo VARCHAR(10) NOT NULL DEFAULT 'ECC',
                descricao TEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_tios_ecc_tenant_numero_tipo (tenant_id, numero, tipo)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS tios_casais (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tenant_id INT NOT NULL,
                ecc_id INT NULL,
                nome_tio VARCHAR(180) NOT NULL,
                telefone_tio VARCHAR(30) NOT NULL,
                data_nascimento_tio DATE NULL,
                nome_tia VARCHAR(180) NOT NULL,
                telefone_tia VARCHAR(30) NOT NULL,
                data_nascimento_tia DATE NULL,
                restricao_alimentar TINYINT(1) NOT NULL DEFAULT 0,
                deficiencia TINYINT(1) NOT NULL DEFAULT 0,
                restricao_alimentar_tio TINYINT(1) NOT NULL DEFAULT 0,
                detalhes_restricao_tio VARCHAR(255) NULL,
                deficiencia_tio TINYINT(1) NOT NULL DEFAULT 0,
                qual_deficiencia_tio VARCHAR(255) NULL,
                restricao_alimentar_tia TINYINT(1) NOT NULL DEFAULT 0,
                detalhes_restricao_tia VARCHAR(255) NULL,
                deficiencia_tia TINYINT(1) NOT NULL DEFAULT 0,
                qual_deficiencia_tia VARCHAR(255) NULL,
                observacoes VARCHAR(255) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                KEY idx_tios_casais_tenant (tenant_id),
                KEY idx_tios_casais_ecc (ecc_id)
            )
        `);
        try { await pool.query("ALTER TABLE tios_casais ADD COLUMN restricao_alimentar TINYINT(1) NOT NULL DEFAULT 0 AFTER data_nascimento_tia"); } catch (e) { }
        try { await pool.query("ALTER TABLE tios_casais ADD COLUMN deficiencia TINYINT(1) NOT NULL DEFAULT 0 AFTER restricao_alimentar"); } catch (e) { }
        try { await pool.query("ALTER TABLE tios_casais ADD COLUMN restricao_alimentar_tio TINYINT(1) NOT NULL DEFAULT 0 AFTER deficiencia"); } catch (e) { }
        try { await pool.query("ALTER TABLE tios_casais ADD COLUMN detalhes_restricao_tio VARCHAR(255) NULL AFTER restricao_alimentar_tio"); } catch (e) { }
        try { await pool.query("ALTER TABLE tios_casais ADD COLUMN deficiencia_tio TINYINT(1) NOT NULL DEFAULT 0 AFTER detalhes_restricao_tio"); } catch (e) { }
        try { await pool.query("ALTER TABLE tios_casais ADD COLUMN qual_deficiencia_tio VARCHAR(255) NULL AFTER deficiencia_tio"); } catch (e) { }
        try { await pool.query("ALTER TABLE tios_casais ADD COLUMN restricao_alimentar_tia TINYINT(1) NOT NULL DEFAULT 0 AFTER qual_deficiencia_tio"); } catch (e) { }
        try { await pool.query("ALTER TABLE tios_casais ADD COLUMN detalhes_restricao_tia VARCHAR(255) NULL AFTER restricao_alimentar_tia"); } catch (e) { }
        try { await pool.query("ALTER TABLE tios_casais ADD COLUMN deficiencia_tia TINYINT(1) NOT NULL DEFAULT 0 AFTER detalhes_restricao_tia"); } catch (e) { }
        try { await pool.query("ALTER TABLE tios_casais ADD COLUMN qual_deficiencia_tia VARCHAR(255) NULL AFTER deficiencia_tia"); } catch (e) { }
    })();

    try {
        await ensureTiosTablesPromise;
    } finally {
        ensureTiosTablesPromise = null;
    }
}

async function ensureTiosVinculos() {
    if (ensureTiosVinculosPromise) return ensureTiosVinculosPromise;
    ensureTiosVinculosPromise = (async () => {
        await ensureTiosTables();
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tios_jovens (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tenant_id INT NOT NULL,
                casal_id INT NOT NULL,
                jovem_id INT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_tio_jovem (tenant_id, jovem_id),
                KEY idx_tios_jovens_casal (casal_id)
            )
        `);
    })();
    try {
        await ensureTiosVinculosPromise;
    } finally {
        ensureTiosVinculosPromise = null;
    }
}

function isTipoEccValido(tipo) {
    return tipo === 'ECC' || tipo === 'ECNA';
}

async function findOrCreateTiosEcc({ tenantId, numero, tipo }) {
    const numeroTxt = String(numero || '').trim();
    const tipoTxt = String(tipo || '').trim().toUpperCase();
    if (!numeroTxt || !isTipoEccValido(tipoTxt)) return null;

    await ensureTiosTables();
    const [eccRows] = await pool.query(
        'SELECT id FROM tios_ecc WHERE tenant_id = ? AND numero = ? AND tipo = ? LIMIT 1',
        [tenantId, numeroTxt, tipoTxt]
    );
    if (eccRows && eccRows.length) return Number(eccRows[0].id);

    const [eccIns] = await pool.query(
        'INSERT INTO tios_ecc (tenant_id, numero, tipo, descricao) VALUES (?, ?, ?, ?)',
        [tenantId, numeroTxt, tipoTxt, null]
    );
    return Number(eccIns.insertId || 0) || null;
}

function montarDadosCasalTios({ principal, conjuge }) {
    const pessoaA = {
        nome: String(principal?.nome_completo || '').trim(),
        telefone: String(principal?.telefone || '').trim(),
        data_nascimento: principal?.data_nascimento || null,
        sexo: String(principal?.sexo || '').trim(),
        restricao_alimentar: principal?.restricao_alimentar ? 1 : 0,
        detalhes_restricao: String(principal?.detalhes_restricao || '').trim() || null,
        deficiencia: principal?.deficiencia ? 1 : 0,
        qual_deficiencia: String(principal?.qual_deficiencia || '').trim() || null
    };
    const pessoaB = {
        nome: String(conjuge?.nome_completo || conjuge?.conjuge_nome || '').trim(),
        telefone: String(conjuge?.telefone || conjuge?.conjuge_telefone || '').trim(),
        data_nascimento: conjuge?.data_nascimento || null,
        sexo: String(conjuge?.sexo || '').trim(),
        restricao_alimentar: conjuge?.restricao_alimentar ? 1 : 0,
        detalhes_restricao: String(conjuge?.detalhes_restricao || '').trim() || null,
        deficiencia: conjuge?.deficiencia ? 1 : 0,
        qual_deficiencia: String(conjuge?.qual_deficiencia || '').trim() || null
    };

    const principalMasculino = pessoaA.sexo === 'Masculino';
    const principalFeminino = pessoaA.sexo === 'Feminino';
    const conjugeMasculino = pessoaB.sexo === 'Masculino';
    const conjugeFeminino = pessoaB.sexo === 'Feminino';

    let tio = pessoaA;
    let tia = pessoaB;
    if (principalMasculino && conjugeFeminino) {
        tio = pessoaA;
        tia = pessoaB;
    } else if (principalFeminino && conjugeMasculino) {
        tio = pessoaB;
        tia = pessoaA;
    } else if (principalMasculino) {
        tio = pessoaA;
        tia = pessoaB;
    } else if (principalFeminino) {
        tio = pessoaB;
        tia = pessoaA;
    } else if (conjugeMasculino) {
        tio = pessoaB;
        tia = pessoaA;
    } else if (conjugeFeminino) {
        tio = pessoaA;
        tia = pessoaB;
    }

    return {
        nome_tio: tio.nome || 'Tio',
        telefone_tio: tio.telefone || '',
        data_nascimento_tio: tio.data_nascimento || null,
        nome_tia: tia.nome || 'Tia',
        telefone_tia: tia.telefone || '',
        data_nascimento_tia: tia.data_nascimento || null,
        restricao_alimentar: (tio.restricao_alimentar || tia.restricao_alimentar) ? 1 : 0,
        deficiencia: (tio.deficiencia || tia.deficiencia) ? 1 : 0,
        restricao_alimentar_tio: tio.restricao_alimentar ? 1 : 0,
        detalhes_restricao_tio: tio.restricao_alimentar ? (tio.detalhes_restricao || null) : null,
        deficiencia_tio: tio.deficiencia ? 1 : 0,
        qual_deficiencia_tio: tio.deficiencia ? (tio.qual_deficiencia || null) : null,
        restricao_alimentar_tia: tia.restricao_alimentar ? 1 : 0,
        detalhes_restricao_tia: tia.restricao_alimentar ? (tia.detalhes_restricao || null) : null,
        deficiencia_tia: tia.deficiencia ? 1 : 0,
        qual_deficiencia_tia: tia.deficiencia ? (tia.qual_deficiencia || null) : null
    };
}

async function upsertCasalParaTios({ tenantId, eccNumero, eccTipo, principal, conjuge }) {
    const eccId = await findOrCreateTiosEcc({ tenantId, numero: eccNumero, tipo: eccTipo });
    if (!eccId) return null;

    const casal = montarDadosCasalTios({ principal, conjuge });
    const [casalExistente] = await pool.query(
        `SELECT id
         FROM tios_casais
         WHERE tenant_id = ?
           AND ecc_id <=> ?
           AND LOWER(nome_tio) = LOWER(?)
           AND LOWER(nome_tia) = LOWER(?)
         LIMIT 1`,
        [tenantId, eccId, casal.nome_tio, casal.nome_tia]
    );

    if (casalExistente && casalExistente.length) {
        const casalId = Number(casalExistente[0].id);
        await pool.query(
            `UPDATE tios_casais
             SET telefone_tio = ?, data_nascimento_tio = ?, telefone_tia = ?, data_nascimento_tia = ?,
                 restricao_alimentar = ?, deficiencia = ?,
                 restricao_alimentar_tio = ?, detalhes_restricao_tio = ?, deficiencia_tio = ?, qual_deficiencia_tio = ?,
                 restricao_alimentar_tia = ?, detalhes_restricao_tia = ?, deficiencia_tia = ?, qual_deficiencia_tia = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND tenant_id = ?`,
            [
                casal.telefone_tio,
                casal.data_nascimento_tio,
                casal.telefone_tia,
                casal.data_nascimento_tia,
                casal.restricao_alimentar,
                casal.deficiencia,
                casal.restricao_alimentar_tio,
                casal.detalhes_restricao_tio,
                casal.deficiencia_tio,
                casal.qual_deficiencia_tio,
                casal.restricao_alimentar_tia,
                casal.detalhes_restricao_tia,
                casal.deficiencia_tia,
                casal.qual_deficiencia_tia,
                casalId,
                tenantId
            ]
        );
        return casalId;
    }

    const [result] = await pool.query(
        `INSERT INTO tios_casais
         (tenant_id, ecc_id, nome_tio, telefone_tio, data_nascimento_tio, nome_tia, telefone_tia, data_nascimento_tia,
          restricao_alimentar, deficiencia,
          restricao_alimentar_tio, detalhes_restricao_tio, deficiencia_tio, qual_deficiencia_tio,
          restricao_alimentar_tia, detalhes_restricao_tia, deficiencia_tia, qual_deficiencia_tia, observacoes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            tenantId,
            eccId,
            casal.nome_tio,
            casal.telefone_tio,
            casal.data_nascimento_tio,
            casal.nome_tia,
            casal.telefone_tia,
            casal.data_nascimento_tia,
            casal.restricao_alimentar,
            casal.deficiencia,
            casal.restricao_alimentar_tio,
            casal.detalhes_restricao_tio,
            casal.deficiencia_tio,
            casal.qual_deficiencia_tio,
            casal.restricao_alimentar_tia,
            casal.detalhes_restricao_tia,
            casal.deficiencia_tia,
            casal.qual_deficiencia_tia,
            null
        ]
    );
    return Number(result.insertId || 0) || null;
}

async function ensureCadastroOrigemColumns() {
    if (ensureCadastroOrigemPromise) return ensureCadastroOrigemPromise;

    ensureCadastroOrigemPromise = (async () => {
        const columns = [
            { name: 'origem_ejc_tipo', sql: "ALTER TABLE jovens ADD COLUMN origem_ejc_tipo ENUM('INCONFIDENTES','OUTRO_EJC') NOT NULL DEFAULT 'INCONFIDENTES' AFTER numero_ejc_fez" },
            { name: 'montagem_ejc_id', sql: "ALTER TABLE jovens ADD COLUMN montagem_ejc_id INT NULL AFTER numero_ejc_fez" },
            { name: 'outro_ejc_id', sql: "ALTER TABLE jovens ADD COLUMN outro_ejc_id INT NULL AFTER origem_ejc_tipo" },
            { name: 'outro_ejc_numero', sql: "ALTER TABLE jovens ADD COLUMN outro_ejc_numero VARCHAR(30) NULL AFTER outro_ejc_id" },
            { name: 'transferencia_outro_ejc', sql: "ALTER TABLE jovens ADD COLUMN transferencia_outro_ejc TINYINT(1) NOT NULL DEFAULT 0 AFTER outro_ejc_numero" },
            { name: 'ja_foi_moita_inconfidentes', sql: "ALTER TABLE jovens ADD COLUMN ja_foi_moita_inconfidentes TINYINT(1) NOT NULL DEFAULT 0 AFTER outro_ejc_numero" },
            { name: 'moita_ejc_id', sql: "ALTER TABLE jovens ADD COLUMN moita_ejc_id INT NULL AFTER ja_foi_moita_inconfidentes" },
            { name: 'moita_funcao', sql: "ALTER TABLE jovens ADD COLUMN moita_funcao VARCHAR(120) NULL AFTER moita_ejc_id" }
        ];

        for (const col of columns) {
            const exists = await hasColumn('jovens', col.name);
            if (exists) continue;
            let tentativas = 0;
            // retry on deadlock
            while (tentativas < 3) {
                try {
                    await pool.query(col.sql);
                    break;
                } catch (err) {
                    if (err && err.code === 'ER_DUP_FIELDNAME') break;
                    if (err && err.code === 'ER_LOCK_DEADLOCK') {
                        tentativas += 1;
                        await new Promise(r => setTimeout(r, 150 * tentativas));
                        continue;
                    }
                    throw err;
                }
            }
        }
    })();

    try {
        await ensureCadastroOrigemPromise;
    } finally {
        ensureCadastroOrigemPromise = null;
    }
}

let ensureConjugeEccPromise = null;
async function ensureConjugeEccColumns() {
    if (ensureConjugeEccPromise) return ensureConjugeEccPromise;
    ensureConjugeEccPromise = (async () => {
        const hasConjugeParoquia = await hasColumn('jovens', 'conjuge_paroquia');
        const colunas = [
            {
                name: 'conjuge_ecc_tipo',
                sql: hasConjugeParoquia
                    ? "ALTER TABLE jovens ADD COLUMN conjuge_ecc_tipo VARCHAR(10) NULL AFTER conjuge_paroquia"
                    : "ALTER TABLE jovens ADD COLUMN conjuge_ecc_tipo VARCHAR(10) NULL"
            },
            {
                name: 'conjuge_ecc_numero',
                sql: "ALTER TABLE jovens ADD COLUMN conjuge_ecc_numero VARCHAR(30) NULL AFTER conjuge_ecc_tipo"
            }
        ];

        for (const coluna of colunas) {
            // eslint-disable-next-line no-await-in-loop
            const exists = await hasColumn('jovens', coluna.name);
            if (exists) continue;
            let tentativas = 0;
            while (tentativas < 3) {
                try {
                    // eslint-disable-next-line no-await-in-loop
                    await pool.query(coluna.sql);
                    break;
                } catch (err) {
                    if (err && err.code === 'ER_DUP_FIELDNAME') break;
                    if (err && err.code === 'ER_LOCK_DEADLOCK') {
                        tentativas += 1;
                        // eslint-disable-next-line no-await-in-loop
                        await new Promise((resolve) => setTimeout(resolve, 150 * tentativas));
                        continue;
                    }
                    throw err;
                }
            }
        }
    })();
    try {
        await ensureConjugeEccPromise;
    } finally {
        ensureConjugeEccPromise = null;
    }
}

function serializarInstrumentos(value, ehMusico) {
    if (!ehMusico) return null;
    let lista = [];
    if (Array.isArray(value)) {
        lista = value.map(v => String(v || '').trim()).filter(Boolean);
    } else if (typeof value === 'string') {
        const texto = value.trim();
        if (texto) {
            try {
                const parsed = JSON.parse(texto);
                if (Array.isArray(parsed)) {
                    lista = parsed.map(v => String(v || '').trim()).filter(Boolean);
                } else {
                    lista = texto.split(',').map(v => v.trim()).filter(Boolean);
                }
            } catch (e) {
                lista = texto.split(',').map(v => v.trim()).filter(Boolean);
            }
        }
    }
    if (!lista.length) return null;
    return JSON.stringify(lista);
}


// GET - Listar todos (API principal da Lista Mestre)
router.get('/', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const removidosDaListaMestre = [];
        await ensureCadastroOrigemColumns();
        await ensureConjugeEccColumns();
        await ensureEmailColumn();
        await ensureApelidoColumn();
        await ensureListaMestreAtivoColumn();
        await ensureEnderecoColumns();
        await ensureEquipeSaudeColumn();
        await ensureNaoServeEjcColumns();
        await ensurePastoraisTables();
        const jovemTelefoneNormalizado = normalizedPhoneExpr('j.telefone');
        const tioTelefoneNormalizado = normalizedPhoneExpr('tc2.telefone_tio');
        const tiaTelefoneNormalizado = normalizedPhoneExpr('tc2.telefone_tia');
        const [rows] = await pool.query(`
            SELECT j.*, e.numero as numero_ejc, e.paroquia as paroquia_ejc,
                   me.id AS montagem_ejc_rel_id, me.numero_ejc AS numero_ejc_montagem,
                   oe.nome AS outro_ejc_nome, oe.paroquia AS outro_ejc_paroquia,
                   eme.numero AS moita_ejc_numero,
                   tj.casal_id AS tio_casal_id,
                   tc.nome_tio AS tio_nome_tio,
                   tc.nome_tia AS tio_nome_tia,
                   (
                       SELECT GROUP_CONCAT(p.nome ORDER BY p.nome SEPARATOR ', ')
                       FROM pastorais_jovens pj
                       JOIN pastorais p ON p.id = pj.pastoral_id AND p.tenant_id = pj.tenant_id
                       WHERE pj.tenant_id = j.tenant_id
                         AND pj.jovem_id = j.id
                   ) AS pastorais_texto
            FROM jovens j 
            LEFT JOIN ejc e ON j.numero_ejc_fez = e.id AND e.tenant_id = j.tenant_id
            LEFT JOIN montagens me ON me.id = j.montagem_ejc_id AND me.tenant_id = j.tenant_id
            LEFT JOIN outros_ejcs oe ON j.outro_ejc_id = oe.id AND oe.tenant_id = j.tenant_id
            LEFT JOIN ejc eme ON j.moita_ejc_id = eme.id AND eme.tenant_id = j.tenant_id
            LEFT JOIN (
                SELECT tenant_id, jovem_id, MAX(casal_id) AS casal_id
                FROM tios_jovens
                GROUP BY tenant_id, jovem_id
            ) tj ON tj.jovem_id = j.id AND tj.tenant_id = j.tenant_id
            LEFT JOIN tios_casais tc ON tc.id = tj.casal_id AND tc.tenant_id = j.tenant_id
            WHERE COALESCE(j.origem_ejc_tipo, 'INCONFIDENTES') <> 'OUTRO_EJC'
              AND COALESCE(j.lista_mestre_ativo, 1) = 1
              AND j.tenant_id = ?
              AND NOT EXISTS (
                  SELECT 1
                  FROM tios_casais tc2
                  WHERE tc2.tenant_id = j.tenant_id
                    AND (
                        (LOWER(TRIM(tc2.nome_tio)) = LOWER(TRIM(j.nome_completo)) AND ${tioTelefoneNormalizado} = ${jovemTelefoneNormalizado})
                        OR
                        (LOWER(TRIM(tc2.nome_tia)) = LOWER(TRIM(j.nome_completo)) AND ${tiaTelefoneNormalizado} = ${jovemTelefoneNormalizado})
                    )
              )
            ORDER BY j.nome_completo ASC
        `, [tenantId]);
        res.json(rows);
    } catch (err) {
        console.error("Erro detalhado no banco:", err);
        res.status(500).json({ error: "Erro interno ao acessar o banco" });
    }
});


// GET - Busca rápida de jovens por nome (autocomplete)
router.get('/search', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    try {
        const tenantId = getTenantId(req);
        const like = `%${q}%`;
        const jovemTelefoneNormalizado = normalizedPhoneExpr('jovens.telefone');
        const tioTelefoneNormalizado = normalizedPhoneExpr('tc2.telefone_tio');
        const tiaTelefoneNormalizado = normalizedPhoneExpr('tc2.telefone_tia');
        const [rows] = await pool.query(`
            SELECT id, nome_completo, circulo, telefone, numero_ejc_fez, sexo, data_nascimento, estado_civil,
                   CASE
                       WHEN data_nascimento IS NULL THEN NULL
                       ELSE TIMESTAMPDIFF(YEAR, data_nascimento, CURDATE())
                   END AS idade
            FROM jovens
            WHERE nome_completo LIKE ?
              AND tenant_id = ?
              AND COALESCE(origem_ejc_tipo, 'INCONFIDENTES') <> 'OUTRO_EJC'
              AND COALESCE(lista_mestre_ativo, 1) = 1
              AND NOT EXISTS (
                  SELECT 1
                  FROM tios_casais tc2
                  WHERE tc2.tenant_id = jovens.tenant_id
                    AND (
                        (LOWER(TRIM(tc2.nome_tio)) = LOWER(TRIM(jovens.nome_completo)) AND ${tioTelefoneNormalizado} = ${jovemTelefoneNormalizado})
                        OR
                        (LOWER(TRIM(tc2.nome_tia)) = LOWER(TRIM(jovens.nome_completo)) AND ${tiaTelefoneNormalizado} = ${jovemTelefoneNormalizado})
                    )
              )
            ORDER BY nome_completo
            LIMIT 20
        `, [like, tenantId]);
        res.json(rows);
    } catch (err) {
        console.error('Erro na busca de jovens:', err);
        res.status(500).json({ error: 'Erro no servidor' });
    }
});

// GET - Registros de moita (para menu Moita)
router.get('/moita/registros', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const comParoquiaCol = await hasColumn('jovens_comissoes', 'paroquia');
        const comFuncaoCol = await hasColumn('jovens_comissoes', 'funcao_garcom');
        const selectParoquia = comParoquiaCol
            ? 'COALESCE(oe.paroquia, jc.paroquia) AS paroquia'
            : 'oe.paroquia AS paroquia';
        const selectFuncao = comFuncaoCol
            ? "COALESCE(jc.funcao_garcom, '-') AS funcao_moita"
            : "'-' AS funcao_moita";

        const [rows] = await pool.query(`
            SELECT 
                jc.id,
                jc.jovem_id,
                j.nome_completo,
                j.telefone,
                j.numero_ejc_fez,
                eorig.numero AS ejc_origem_numero,
                jc.ejc_numero,
                ${selectParoquia},
                ${selectFuncao}
            FROM jovens_comissoes jc
            JOIN jovens j ON j.id = jc.jovem_id
            LEFT JOIN ejc eorig ON eorig.id = j.numero_ejc_fez AND eorig.tenant_id = jc.tenant_id
            LEFT JOIN outros_ejcs oe ON oe.id = jc.outro_ejc_id AND oe.tenant_id = jc.tenant_id
            WHERE jc.tipo = 'MOITA_OUTRO'
              AND jc.tenant_id = ?
            ORDER BY jc.id DESC
        `, [tenantId]);
        res.json(rows);
    } catch (err) {
        console.error("Erro ao listar registros de moita:", err);
        res.status(500).json({ error: "Erro ao listar registros de moita" });
    }
});

// GET - Relatório completo de histórico para exportação
router.get('/relatorio/historico-completo', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const comSubfuncao = await hasSubfuncaoColumn();
        const subfuncaoSelect = comSubfuncao ? 'he.subfuncao' : 'NULL as subfuncao';
        const [rows] = await pool.query(`
            SELECT he.jovem_id, he.equipe, he.papel, ${subfuncaoSelect}, e.numero as numero_ejc, e.id as ejc_id
            FROM historico_equipes he
            JOIN ejc e ON he.ejc_id = e.id AND e.tenant_id = he.tenant_id
            WHERE he.tenant_id = ?
            ORDER BY he.jovem_id, e.numero
        `, [tenantId]);
        res.json(rows);
    } catch (err) {
        console.error("Erro ao buscar histórico completo:", err);
        res.status(500).json({ error: "Erro no servidor" });
    }
});

// GET - Detalhes extras para exportação (eventos, moita, garçom)
router.get('/exportacao/detalhes', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const detalhes = {
            eventosPorJovem: {},
            moitaPorJovem: {},
            garcomPorJovem: {}
        };

        const hasForms = await hasTable('formularios_itens');
        const hasPresencas = await hasTable('formularios_presencas');
        if (hasForms && hasPresencas) {
            const [rowsEventos] = await pool.query(`
                SELECT fp.jovem_id,
                       GROUP_CONCAT(DISTINCT COALESCE(fi.titulo, 'Evento sem título') SEPARATOR ' | ') AS eventos
                FROM formularios_presencas fp
                JOIN formularios_itens fi ON fi.id = fp.formulario_id
                WHERE fp.jovem_id IS NOT NULL
                  AND fp.tenant_id = ?
                GROUP BY fp.jovem_id
            `, [tenantId]);
            rowsEventos.forEach((r) => {
                detalhes.eventosPorJovem[r.jovem_id] = r.eventos || '';
            });
        }

        const hasComissoes = await hasTable('jovens_comissoes');
        if (hasComissoes) {
            const [rowsMoita] = await pool.query(`
                SELECT jc.jovem_id,
                       GROUP_CONCAT(
                           DISTINCT CONCAT(
                               COALESCE(CAST(jc.ejc_numero AS CHAR), '-'),
                               'º EJC',
                               CASE WHEN oe.paroquia IS NOT NULL THEN CONCAT(' - ', oe.paroquia) ELSE '' END
                           )
                           SEPARATOR ' | '
                       ) AS moita_info
                FROM jovens_comissoes jc
                LEFT JOIN outros_ejcs oe ON oe.id = jc.outro_ejc_id AND oe.tenant_id = jc.tenant_id
                WHERE jc.tipo = 'MOITA_OUTRO'
                  AND jc.tenant_id = ?
                GROUP BY jc.jovem_id
            `, [tenantId]);
            rowsMoita.forEach((r) => {
                detalhes.moitaPorJovem[r.jovem_id] = r.moita_info || '';
            });

            const [rowsGarcom] = await pool.query(`
                SELECT jc.jovem_id,
                       GROUP_CONCAT(
                           DISTINCT CONCAT(
                               COALESCE(jc.tipo, ''),
                               CASE WHEN jc.ejc_numero IS NOT NULL THEN CONCAT(' - ', jc.ejc_numero, 'º EJC') ELSE '' END,
                               CASE WHEN oe.paroquia IS NOT NULL THEN CONCAT(' - ', oe.paroquia) ELSE '' END,
                               CASE WHEN jc.funcao_garcom IS NOT NULL THEN CONCAT(' - ', jc.funcao_garcom) ELSE '' END
                           )
                           SEPARATOR ' | '
                       ) AS garcom_info
                FROM jovens_comissoes jc
                LEFT JOIN outros_ejcs oe ON oe.id = jc.outro_ejc_id AND oe.tenant_id = jc.tenant_id
                WHERE jc.tipo IN ('GARCOM_OUTRO', 'GARCOM_EQUIPE')
                  AND jc.tenant_id = ?
                GROUP BY jc.jovem_id
            `, [tenantId]);
            rowsGarcom.forEach((r) => {
                detalhes.garcomPorJovem[r.jovem_id] = r.garcom_info || '';
            });
        }

        return res.json(detalhes);
    } catch (err) {
        console.error('Erro ao buscar detalhes de exportação:', err);
        return res.status(500).json({ error: 'Erro ao buscar detalhes de exportação.' });
    }
});

router.get('/jovens-outro-ejc', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const removidosDaListaMestre = [];
        await ensureCadastroOrigemColumns();
        await ensureConjugeEccColumns();
        const comEhMusico = await hasEhMusicoColumn();
        const hasOutrosEjcs = await hasTable('outros_ejcs');
        const hasPresencas = await hasTable('formularios_presencas');
        const hasFormItens = await hasTable('formularios_itens');
        const hasComissoes = await hasTable('jovens_comissoes');
        const hasHistorico = await hasTable('historico_equipes');

        const mapa = new Map();
        const norm = (v) => String(v || '').trim();
        const keyOf = (id, nome, tel) => {
            if (id && Number(id) > 0) return `id:${id}`;
            const n = norm(nome).toLowerCase();
            const t = norm(tel).replace(/\D/g, '');
            return `tmp:${n}|${t}`;
        };
        const upsert = (item) => {
            const nome = norm(item.nome_completo || item.nome);
            const telefone = norm(item.telefone);
            const origemTipo = norm(item.origem_ejc_tipo).toUpperCase();
            const transferenciaOutroEjc = Number(item.transferencia_outro_ejc || 0) === 1;
            if (!nome) return;
            if (item.jovem_id && (origemTipo && origemTipo !== 'OUTRO_EJC')) return;
            if (item.jovem_id && transferenciaOutroEjc) return;
            const key = keyOf(item.jovem_id, nome, telefone);
            if (!mapa.has(key)) {
                mapa.set(key, {
                    jovem_id: item.jovem_id || null,
                    nome_completo: nome,
                    telefone: telefone || '-',
                    outro_ejc_id: item.outro_ejc_id || null,
                    outro_ejc_nome: norm(item.outro_ejc_nome) || null,
                    outro_ejc_paroquia: norm(item.outro_ejc_paroquia) || null,
                    eh_musico: Number(item.eh_musico || 0) === 1,
                    termos_aceitos_em: item.termos_aceitos_em || null,
                    origem_ejc_tipo: origemTipo || null,
                    transferencia_outro_ejc: transferenciaOutroEjc ? 1 : 0,
                    fontes: new Set(),
                    detalhes: new Set(),
                    historico_equipes_map: new Map()
                });
            }
            const atual = mapa.get(key);
            if (item.jovem_id && !atual.jovem_id) atual.jovem_id = item.jovem_id;
            if (!atual.telefone || atual.telefone === '-') atual.telefone = telefone || '-';
            if (!atual.outro_ejc_id && item.outro_ejc_id) atual.outro_ejc_id = item.outro_ejc_id;
            if (!atual.outro_ejc_nome && item.outro_ejc_nome) atual.outro_ejc_nome = norm(item.outro_ejc_nome);
            if (!atual.outro_ejc_paroquia && item.outro_ejc_paroquia) atual.outro_ejc_paroquia = norm(item.outro_ejc_paroquia);
            if (!atual.eh_musico && Number(item.eh_musico || 0) === 1) atual.eh_musico = true;
            if (!atual.termos_aceitos_em && item.termos_aceitos_em) atual.termos_aceitos_em = item.termos_aceitos_em;
            if (!atual.origem_ejc_tipo && origemTipo) atual.origem_ejc_tipo = origemTipo;
            if (!atual.transferencia_outro_ejc && transferenciaOutroEjc) atual.transferencia_outro_ejc = 1;
            if (item.fonte) atual.fontes.add(item.fonte);
            if (item.detalhe) atual.detalhes.add(item.detalhe);
        };

        const [baseRows] = await pool.query(`
            SELECT j.id AS jovem_id, j.nome_completo, j.telefone, j.outro_ejc_id,
                   ${comEhMusico ? 'j.eh_musico' : '0 AS eh_musico'},
                   j.termos_aceitos_em,
                   j.origem_ejc_tipo, j.transferencia_outro_ejc,
                   ${hasOutrosEjcs ? 'oe.nome AS outro_ejc_nome, oe.paroquia AS outro_ejc_paroquia' : 'NULL AS outro_ejc_nome, NULL AS outro_ejc_paroquia'}
            FROM jovens j
            ${hasOutrosEjcs ? 'LEFT JOIN outros_ejcs oe ON oe.id = j.outro_ejc_id AND oe.tenant_id = j.tenant_id' : ''}
            WHERE j.origem_ejc_tipo = 'OUTRO_EJC'
              AND COALESCE(j.transferencia_outro_ejc, 0) = 0
              AND j.tenant_id = ?
            ORDER BY j.nome_completo ASC
        `, [tenantId]);
        baseRows.forEach((r) => upsert({ ...r, fonte: 'Lista Mestre', detalhe: 'Cadastrado como jovem de outro EJC' }));

        if (hasComissoes) {
            const [comRows] = await pool.query(`
                SELECT jc.jovem_id,
                       COALESCE(j.nome_completo, '') AS nome_completo,
                       COALESCE(j.telefone, '') AS telefone,
                       COALESCE(j.outro_ejc_id, jc.outro_ejc_id) AS outro_ejc_id,
                       ${comEhMusico ? 'COALESCE(j.eh_musico, 0) AS eh_musico,' : '0 AS eh_musico,'}
                       j.termos_aceitos_em,
                       j.origem_ejc_tipo, j.transferencia_outro_ejc,
                       ${hasOutrosEjcs ? 'oe.nome AS outro_ejc_nome, oe.paroquia AS outro_ejc_paroquia' : 'NULL AS outro_ejc_nome, NULL AS outro_ejc_paroquia'},
                       jc.tipo, jc.ejc_numero, jc.funcao_garcom
                FROM jovens_comissoes jc
                LEFT JOIN jovens j ON j.id = jc.jovem_id
                ${hasOutrosEjcs ? 'LEFT JOIN outros_ejcs oe ON oe.id = COALESCE(j.outro_ejc_id, jc.outro_ejc_id) AND oe.tenant_id = jc.tenant_id' : ''}
                WHERE jc.jovem_id IS NOT NULL
                  AND jc.tenant_id = ?
                  AND COALESCE(j.transferencia_outro_ejc, 0) = 0
                  AND COALESCE(j.origem_ejc_tipo, 'INCONFIDENTES') = 'OUTRO_EJC'
            `, [tenantId]);
            comRows.forEach((r) => {
                const tipo = String(r.tipo || '').toUpperCase();
                const fonte = tipo.includes('MOITA') ? 'Moita' : (tipo.includes('GARCOM') ? 'Garçons' : 'Comissões');
                const detalhe = [r.tipo, r.ejc_numero ? `${r.ejc_numero}º EJC` : null, r.funcao_garcom || null].filter(Boolean).join(' - ');
                upsert({ ...r, fonte, detalhe: detalhe || 'Registro em comissão' });
            });
        }

        if (hasHistorico) {
            const comSubfuncao = await hasSubfuncaoColumn();
            const [histRows] = await pool.query(`
                SELECT he.jovem_id, j.nome_completo, j.telefone, j.outro_ejc_id,
                       ${comEhMusico ? 'COALESCE(j.eh_musico, 0) AS eh_musico,' : '0 AS eh_musico,'}
                       j.termos_aceitos_em,
                       j.origem_ejc_tipo, j.transferencia_outro_ejc,
                       ${hasOutrosEjcs ? 'oe.nome AS outro_ejc_nome, oe.paroquia AS outro_ejc_paroquia' : 'NULL AS outro_ejc_nome, NULL AS outro_ejc_paroquia'},
                       he.equipe, he.papel, ${comSubfuncao ? 'he.subfuncao' : 'NULL AS subfuncao'},
                       he.ejc_id, he.edicao_ejc,
                       e.numero AS ejc_numero, e.paroquia AS ejc_paroquia
                FROM historico_equipes he
                JOIN jovens j ON j.id = he.jovem_id AND j.tenant_id = he.tenant_id
                ${hasOutrosEjcs ? 'LEFT JOIN outros_ejcs oe ON oe.id = j.outro_ejc_id AND oe.tenant_id = he.tenant_id' : ''}
                LEFT JOIN ejc e ON e.id = he.ejc_id AND e.tenant_id = he.tenant_id
                WHERE j.origem_ejc_tipo = 'OUTRO_EJC'
                  AND COALESCE(j.transferencia_outro_ejc, 0) = 0
                  AND he.tenant_id = ?
            `, [tenantId]);
            histRows.forEach((r) => {
                const detalhe = [r.equipe || null, r.papel || null, r.subfuncao || null].filter(Boolean).join(' - ');
                upsert({ ...r, fonte: 'Equipes', detalhe: detalhe || 'Serviu em equipe' });
                const key = keyOf(r.jovem_id, r.nome_completo, r.telefone);
                if (!mapa.has(key)) return;
                const atual = mapa.get(key);
                const histKey = [
                    r.ejc_id || 0,
                    r.ejc_numero || 0,
                    norm(r.edicao_ejc),
                    norm(r.equipe),
                    norm(r.papel),
                    norm(r.subfuncao)
                ].join('|');
                if (atual.historico_equipes_map.has(histKey)) return;
                atual.historico_equipes_map.set(histKey, {
                    ejc_id: r.ejc_id ? Number(r.ejc_id) : null,
                    ejc_numero: r.ejc_numero ? Number(r.ejc_numero) : null,
                    ejc_paroquia: norm(r.ejc_paroquia) || null,
                    edicao_ejc: norm(r.edicao_ejc) || null,
                    equipe: norm(r.equipe) || null,
                    papel: norm(r.papel) || null,
                    subfuncao: norm(r.subfuncao) || null
                });
            });
        }

        if (hasPresencas && hasFormItens) {
            const [presRows] = await pool.query(`
                SELECT fp.jovem_id,
                       COALESCE(fp.nome_completo, j.nome_completo) AS nome_completo,
                       COALESCE(fp.telefone, j.telefone) AS telefone,
                       COALESCE(fp.outro_ejc_id, j.outro_ejc_id) AS outro_ejc_id,
                       ${comEhMusico ? 'COALESCE(j.eh_musico, 0) AS eh_musico,' : '0 AS eh_musico,'}
                       j.termos_aceitos_em,
                       j.origem_ejc_tipo, j.transferencia_outro_ejc,
                       ${hasOutrosEjcs ? 'oe.nome AS outro_ejc_nome, oe.paroquia AS outro_ejc_paroquia' : 'NULL AS outro_ejc_nome, NULL AS outro_ejc_paroquia'},
                       fi.titulo
                FROM formularios_presencas fp
                LEFT JOIN jovens j ON j.id = fp.jovem_id AND j.tenant_id = fp.tenant_id
                LEFT JOIN formularios_itens fi ON fi.id = fp.formulario_id AND fi.tenant_id = fp.tenant_id
                ${hasOutrosEjcs ? 'LEFT JOIN outros_ejcs oe ON oe.id = COALESCE(fp.outro_ejc_id, j.outro_ejc_id) AND oe.tenant_id = fp.tenant_id' : ''}
                WHERE fp.tenant_id = ?
                  AND COALESCE(j.transferencia_outro_ejc, 0) = 0
                  AND (
                      (fp.jovem_id IS NOT NULL AND COALESCE(j.origem_ejc_tipo, 'INCONFIDENTES') = 'OUTRO_EJC')
                   OR (fp.jovem_id IS NULL AND (fp.origem_ja_fez = 'OUTRO_EJC' OR fp.outro_ejc_id IS NOT NULL))
                  )
            `, [tenantId]);
            presRows.forEach((r) => upsert({ ...r, fonte: 'Eventos/Formulários', detalhe: r.titulo ? `Presença em: ${r.titulo}` : 'Presença em evento' }));
        }

        const itens = Array.from(mapa.values())
            .filter((i) => {
                if (!i.jovem_id) return true;
                if (Number(i.transferencia_outro_ejc || 0) === 1) return false;
                return String(i.origem_ejc_tipo || '').trim().toUpperCase() === 'OUTRO_EJC';
            })
            .map((i) => ({
                jovem_id: i.jovem_id,
                nome_completo: i.nome_completo,
                telefone: i.telefone,
                outro_ejc_id: i.outro_ejc_id,
                outro_ejc_nome: i.outro_ejc_nome,
                outro_ejc_paroquia: i.outro_ejc_paroquia,
                eh_musico: !!i.eh_musico,
                termos_aceitos_em: i.termos_aceitos_em || null,
                fontes: Array.from(i.fontes).sort(),
                detalhes: Array.from(i.detalhes).sort(),
                historico_equipes: Array.from(i.historico_equipes_map.values()).sort((a, b) => {
                    const numA = Number(a.ejc_numero || 0);
                    const numB = Number(b.ejc_numero || 0);
                    if (numA !== numB) return numB - numA;
                    return String(a.equipe || '').localeCompare(String(b.equipe || ''), 'pt-BR');
                })
            }))
            .sort((a, b) => a.nome_completo.localeCompare(b.nome_completo, 'pt-BR'));

        return res.json(itens);
    } catch (err) {
        console.error('Erro ao listar jovens de outro EJC:', err);
        return res.status(500).json({ error: 'Erro ao listar jovens de outro EJC.' });
    }
});

router.get('/ejcs-opcoes', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const [[hasMontagensTable]] = await pool.query(
            `SELECT COUNT(*) AS cnt
             FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'montagens'`
        );
        const [ejcsRows] = await pool.query(
            'SELECT id, numero, paroquia, ano, data_inicio, data_fim, data_encontro FROM ejc WHERE tenant_id = ? ORDER BY numero DESC',
            [tenantId]
        );

        const lista = Array.isArray(ejcsRows) ? ejcsRows.map((item) => ({ ...item, em_montagem: false })) : [];
        const porNumero = new Map(lista.map((item) => [Number(item.numero), item]));

        if (hasMontagensTable && hasMontagensTable.cnt > 0) {
            const [montagensRows] = await pool.query(
                'SELECT id, numero_ejc, data_encontro, data_inicio, data_fim FROM montagens WHERE tenant_id = ? ORDER BY numero_ejc DESC, id DESC',
                [tenantId]
            );
            for (const montagem of montagensRows || []) {
                const numero = Number(montagem.numero_ejc);
                if (!Number.isFinite(numero) || numero <= 0) continue;
                const existente = porNumero.get(numero);
                if (existente) {
                    existente.em_montagem = true;
                    existente.montagem_id = montagem.id;
                    existente.id = `montagem:${montagem.id}`;
                    continue;
                }
                lista.push({
                    id: `montagem:${montagem.id}`,
                    numero,
                    paroquia: null,
                    ano: null,
                    data_inicio: montagem.data_inicio || null,
                    data_fim: montagem.data_fim || null,
                    data_encontro: montagem.data_encontro || null,
                    em_montagem: true,
                    montagem_id: montagem.id
                });
            }
        }

        lista.sort((a, b) => Number(b.numero || 0) - Number(a.numero || 0));
        return res.json(lista);
    } catch (err) {
        console.error('Erro ao listar opções de EJC para Lista Mestre:', err);
        return res.status(500).json({ error: 'Erro ao carregar EJCs.' });
    }
});

// GET - Buscar um jovem por id
router.get('/:id', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const removidosDaListaMestre = [];
        await ensureCadastroOrigemColumns();
        await ensureConjugeEccColumns();
        await ensureEmailColumn();
        await ensureApelidoColumn();
        await ensureEnderecoColumns();
        await ensureEquipeSaudeColumn();
        await ensureNaoServeEjcColumns();
        const [rows] = await pool.query(`
            SELECT j.*, e.numero as numero_ejc, e.paroquia as paroquia_ejc,
                   me.id AS montagem_ejc_rel_id, me.numero_ejc AS numero_ejc_montagem,
                   oe.nome AS outro_ejc_nome, oe.paroquia AS outro_ejc_paroquia,
                   eme.numero AS moita_ejc_numero,
                   tj.casal_id AS tio_casal_id,
                   tc.nome_tio AS tio_nome_tio,
                   tc.nome_tia AS tio_nome_tia
            FROM jovens j
            LEFT JOIN ejc e ON j.numero_ejc_fez = e.id AND e.tenant_id = j.tenant_id
            LEFT JOIN montagens me ON me.id = j.montagem_ejc_id AND me.tenant_id = j.tenant_id
            LEFT JOIN outros_ejcs oe ON j.outro_ejc_id = oe.id AND oe.tenant_id = j.tenant_id
            LEFT JOIN ejc eme ON j.moita_ejc_id = eme.id AND eme.tenant_id = j.tenant_id
            LEFT JOIN tios_jovens tj ON tj.jovem_id = j.id AND tj.tenant_id = j.tenant_id
            LEFT JOIN tios_casais tc ON tc.id = tj.casal_id AND tc.tenant_id = j.tenant_id
            WHERE j.id = ?
              AND j.tenant_id = ?
        `, [req.params.id, tenantId]);
        if (rows.length === 0) return res.status(404).json({ error: 'Jovem não encontrado' });
        res.json(rows[0]);
    } catch (err) {
        console.error('Erro ao buscar jovem:', err);
        res.status(500).json({ error: 'Erro no servidor' });
    }
});

// POST - Criar novo jovem
router.post('/', async (req, res) => {
    function normalizeDate(d) {
        if (d === null || d === undefined || d === '') return null;
        if (typeof d === 'string') {
            if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
            if (d.indexOf('T') !== -1) return d.split('T')[0];
        }
        try {
            const dt = new Date(d);
            if (isNaN(dt.getTime())) return null;
            return dt.toISOString().split('T')[0];
        } catch (e) { return null; }
    }

    try {
        const tenantId = getTenantId(req);
        await ensureCadastroOrigemColumns();
        await ensureConjugeEccColumns();
        await ensureEmailColumn();
        await ensureApelidoColumn();
        await ensureEnderecoColumns();
        await ensureEquipeSaudeColumn();
        await ensureNaoServeEjcColumns();
        const {
            nome_completo, apelido, telefone, email, data_nascimento, numero_ejc_fez, instagram, estado_civil, data_casamento,
            circulo, deficiencia, qual_deficiencia, restricao_alimentar, detalhes_restricao, sexo,
            endereco_rua, endereco_numero, endereco_bairro, endereco_cidade, endereco_cep, equipe_saude,
            origem_ejc_tipo, outro_ejc_id, outro_ejc_numero, ja_foi_moita_inconfidentes, moita_ejc_id, moita_funcao
        } = req.body;

        if (!nome_completo || !telefone) {
            return res.status(400).json({ error: "Nome completo e telefone são obrigatórios" });
        }

        const comEhMusico = await hasEhMusicoColumn();
        const comInstrumentos = await hasInstrumentosMusicaisColumn();
        const comSexo = await hasSexoColumn();
        const ehMusico = !!req.body.eh_musico;

        const transferenciaOutroEjcSolicitada = !!req.body.transferencia_outro_ejc;
        const origemTipo = transferenciaOutroEjcSolicitada ? 'INCONFIDENTES' : ((origem_ejc_tipo === 'OUTRO_EJC') ? 'OUTRO_EJC' : 'INCONFIDENTES');
        const numeroEjcResolvido = await resolveNumeroEjcFezInput({ tenantId, value: numero_ejc_fez });
        const numeroEjcInconfidentes = origemTipo === 'INCONFIDENTES' ? (numeroEjcResolvido.numero_ejc_fez || null) : null;
        const montagemEjcId = origemTipo === 'INCONFIDENTES' ? (numeroEjcResolvido.montagem_ejc_id || null) : null;
        const outroEjcId = origemTipo === 'OUTRO_EJC' ? (outro_ejc_id || null) : null;
        const outroEjcNumero = origemTipo === 'OUTRO_EJC' ? (String(outro_ejc_numero || '').trim() || null) : null;
        const transferenciaOutroEjc = transferenciaOutroEjcSolicitada ? 1 : (origemTipo === 'OUTRO_EJC' && req.body.transferencia_outro_ejc ? 1 : 0);
        const foiMoita = !!ja_foi_moita_inconfidentes;

        const duplicidade = await validarDuplicidadeJovemListaMestre({
            tenantId,
            telefone,
            email,
            instagram
        });
        if (duplicidade) {
            return res.status(409).json({ error: duplicidade.error, campo: duplicidade.campo });
        }

        const campos = [
            'tenant_id',
            'nome_completo',
            'apelido',
            'telefone',
            'email',
            'data_nascimento',
            'numero_ejc_fez',
            'montagem_ejc_id',
            'origem_ejc_tipo',
            'outro_ejc_id',
            'outro_ejc_numero',
            'transferencia_outro_ejc',
            'instagram',
            'estado_civil',
            'data_casamento',
            'circulo',
            'deficiencia',
            'qual_deficiencia',
            'restricao_alimentar',
            'detalhes_restricao',
            'equipe_saude',
            'endereco_rua',
            'endereco_numero',
            'endereco_bairro',
            'endereco_cidade',
            'endereco_cep',
            'ja_foi_moita_inconfidentes',
            'moita_ejc_id',
            'moita_funcao'
        ];
        const valores = [
            tenantId,
            nome_completo,
            apelido ? String(apelido).trim() : null,
            telefone,
            email || null,
            normalizeDate(data_nascimento),
            numeroEjcInconfidentes,
            montagemEjcId,
            origemTipo,
            outroEjcId,
            outroEjcNumero,
            transferenciaOutroEjc,
            instagram || null,
            estado_civil || 'Solteiro',
            normalizeDate(data_casamento),
            circulo || null,
            deficiencia ? 1 : 0,
            qual_deficiencia || null,
            restricao_alimentar ? 1 : 0,
            detalhes_restricao || null,
            equipe_saude ? 1 : 0,
            endereco_rua ? String(endereco_rua).trim() : null,
            endereco_numero ? String(endereco_numero).trim() : null,
            endereco_bairro ? String(endereco_bairro).trim() : null,
            endereco_cidade ? String(endereco_cidade).trim() : null,
            endereco_cep ? String(endereco_cep).trim() : null,
            foiMoita ? 1 : 0,
            foiMoita ? (moita_ejc_id || null) : null,
            foiMoita ? (String(moita_funcao || '').trim() || null) : null
        ];

        if (comSexo) {
            campos.push('sexo');
            valores.push((sexo === 'Feminino' || sexo === 'Masculino') ? sexo : null);
        }

        if (comEhMusico) {
            campos.push('eh_musico');
            valores.push(ehMusico ? 1 : 0);
        }
        if (comInstrumentos) {
            campos.push('instrumentos_musicais');
            valores.push(serializarInstrumentos(req.body.instrumentos_musicais, ehMusico));
        }

        const placeholders = campos.map(() => '?').join(', ');
        const [result] = await pool.query(
            `INSERT INTO jovens (${campos.join(', ')}) VALUES (${placeholders})`,
            valores
        );

        await vincularPresencasOutroEjcSemCadastro({
            tenantId,
            jovemId: result.insertId,
            nomeAtual: nome_completo,
            telefoneAtual: telefone,
            outroEjcIdAtual: outroEjcId,
            nomeOriginal: req.body.vincular_presencas_nome || nome_completo,
            telefoneOriginal: req.body.vincular_presencas_telefone || telefone,
            outroEjcIdOriginal: req.body.vincular_presencas_outro_ejc_id || outroEjcId
        });

        res.json({ id: result.insertId, message: "Jovem criado com sucesso" });
    } catch (err) {
        const msg = err && (err.sqlMessage || err.message) ? (err.sqlMessage || err.message) : "Erro ao criar jovem";
        console.error("Erro ao criar jovem:", err);
        res.status(500).json({ error: msg });
    }
});

// PUT - Atualizar jovem
router.put('/:id', async (req, res) => {
    const { id } = req.params;

    function normalizeDate(d) {
        if (d === null || d === undefined || d === '') return null;
        if (typeof d === 'string') {
            if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
            if (d.indexOf('T') !== -1) return d.split('T')[0];
        }
        try {
            const dt = new Date(d);
            if (isNaN(dt.getTime())) return null;
            return dt.toISOString().split('T')[0];
        } catch (e) { return null; }
    }

    try {
        const tenantId = getTenantId(req);
        const removidosDaListaMestre = [];
        await ensureCadastroOrigemColumns();
        await ensureConjugeEccColumns();
        await ensureEmailColumn();
        await ensureApelidoColumn();
        await ensureEnderecoColumns();
        await ensureEquipeSaudeColumn();
        await ensureNaoServeEjcColumns();
        const [rows] = await pool.query('SELECT * FROM jovens WHERE id = ? AND tenant_id = ?', [id, tenantId]);
        if (rows.length === 0) return res.status(404).json({ error: 'Jovem não encontrado' });
        const atual = rows[0];

        function actualValueOrNull(v) { return v === undefined ? null : v; }

        const merged = {
            nome_completo: req.body.nome_completo !== undefined ? req.body.nome_completo : atual.nome_completo,
            apelido: req.body.apelido !== undefined ? req.body.apelido : atual.apelido,
            telefone: req.body.telefone !== undefined ? req.body.telefone : atual.telefone,
            email: req.body.email !== undefined ? req.body.email : (atual.email === undefined ? null : atual.email),
            sexo: req.body.sexo !== undefined ? req.body.sexo : atual.sexo,
            data_nascimento: req.body.data_nascimento !== undefined ? normalizeDate(req.body.data_nascimento) : (atual.data_nascimento ? normalizeDate(atual.data_nascimento) : null),
            numero_ejc_fez: req.body.numero_ejc_fez !== undefined ? req.body.numero_ejc_fez : atual.numero_ejc_fez,
            montagem_ejc_id: req.body.numero_ejc_fez !== undefined ? null : (atual.montagem_ejc_id || null),
            origem_ejc_tipo: req.body.origem_ejc_tipo !== undefined ? req.body.origem_ejc_tipo : atual.origem_ejc_tipo,
            outro_ejc_id: req.body.outro_ejc_id !== undefined ? req.body.outro_ejc_id : atual.outro_ejc_id,
            outro_ejc_numero: req.body.outro_ejc_numero !== undefined ? req.body.outro_ejc_numero : atual.outro_ejc_numero,
            transferencia_outro_ejc: req.body.transferencia_outro_ejc !== undefined ? (req.body.transferencia_outro_ejc ? 1 : 0) : (atual.transferencia_outro_ejc ? 1 : 0),
            instagram: req.body.instagram !== undefined ? req.body.instagram : (atual.instagram === undefined ? null : atual.instagram),
            estado_civil: req.body.estado_civil !== undefined ? req.body.estado_civil : atual.estado_civil,
            data_casamento: req.body.data_casamento !== undefined ? normalizeDate(req.body.data_casamento) : (atual.data_casamento ? normalizeDate(atual.data_casamento) : null),
            circulo: req.body.circulo !== undefined ? req.body.circulo : atual.circulo,
            deficiencia: req.body.deficiencia !== undefined ? (req.body.deficiencia ? 1 : 0) : (typeof atual.deficiencia === 'number' ? atual.deficiencia : (atual.deficiencia ? 1 : 0)),
            qual_deficiencia: req.body.qual_deficiencia !== undefined ? req.body.qual_deficiencia : atual.qual_deficiencia,
            restricao_alimentar: req.body.restricao_alimentar !== undefined ? (req.body.restricao_alimentar ? 1 : 0) : (atual.restricao_alimentar ? 1 : 0),
            detalhes_restricao: req.body.detalhes_restricao !== undefined ? req.body.detalhes_restricao : atual.detalhes_restricao,
            endereco_rua: req.body.endereco_rua !== undefined ? req.body.endereco_rua : atual.endereco_rua,
            endereco_numero: req.body.endereco_numero !== undefined ? req.body.endereco_numero : atual.endereco_numero,
            endereco_bairro: req.body.endereco_bairro !== undefined ? req.body.endereco_bairro : atual.endereco_bairro,
            endereco_cidade: req.body.endereco_cidade !== undefined ? req.body.endereco_cidade : atual.endereco_cidade,
            endereco_cep: req.body.endereco_cep !== undefined ? req.body.endereco_cep : atual.endereco_cep,
            conjuge_id: req.body.conjuge_id !== undefined ? req.body.conjuge_id : atual.conjuge_id,
            conjuge_nome: req.body.conjuge_nome !== undefined ? req.body.conjuge_nome : atual.conjuge_nome,
            conjuge_telefone: req.body.conjuge_telefone !== undefined ? req.body.conjuge_telefone : actualValueOrNull(atual.conjuge_telefone),
            conjuge_ejc_id: req.body.conjuge_ejc_id !== undefined ? req.body.conjuge_ejc_id : atual.conjuge_ejc_id,
            conjuge_outro_ejc_id: req.body.conjuge_outro_ejc_id !== undefined ? req.body.conjuge_outro_ejc_id : atual.conjuge_outro_ejc_id,
            conjuge_paroquia: req.body.conjuge_paroquia !== undefined ? req.body.conjuge_paroquia : atual.conjuge_paroquia,
            conjuge_ecc_tipo: req.body.conjuge_ecc_tipo !== undefined ? req.body.conjuge_ecc_tipo : atual.conjuge_ecc_tipo,
            conjuge_ecc_numero: req.body.conjuge_ecc_numero !== undefined ? req.body.conjuge_ecc_numero : atual.conjuge_ecc_numero,
            eh_musico: req.body.eh_musico !== undefined ? (req.body.eh_musico ? 1 : 0) : (atual.eh_musico ? 1 : 0),
            equipe_saude: req.body.equipe_saude !== undefined ? (req.body.equipe_saude ? 1 : 0) : (atual.equipe_saude ? 1 : 0),
            instrumentos_musicais: req.body.instrumentos_musicais !== undefined ? req.body.instrumentos_musicais : atual.instrumentos_musicais,
            observacoes_extras: req.body.observacoes_extras !== undefined ? req.body.observacoes_extras : atual.observacoes_extras,
            nao_serve_ejc: req.body.nao_serve_ejc !== undefined ? (req.body.nao_serve_ejc ? 1 : 0) : (atual.nao_serve_ejc ? 1 : 0),
            motivo_nao_serve_ejc: req.body.motivo_nao_serve_ejc !== undefined ? req.body.motivo_nao_serve_ejc : atual.motivo_nao_serve_ejc,
            ja_foi_moita_inconfidentes: req.body.ja_foi_moita_inconfidentes !== undefined ? (req.body.ja_foi_moita_inconfidentes ? 1 : 0) : (atual.ja_foi_moita_inconfidentes ? 1 : 0),
            moita_ejc_id: req.body.moita_ejc_id !== undefined ? req.body.moita_ejc_id : atual.moita_ejc_id,
            moita_funcao: req.body.moita_funcao !== undefined ? req.body.moita_funcao : atual.moita_funcao,
            tio_casal_id: req.body.tio_casal_id !== undefined ? req.body.tio_casal_id : atual.tio_casal_id
        };
        if (!merged.nao_serve_ejc) {
            merged.motivo_nao_serve_ejc = null;
        }
        if (req.body.numero_ejc_fez !== undefined) {
            const selecaoEjc = await resolveNumeroEjcFezInput({ tenantId, value: req.body.numero_ejc_fez });
            merged.numero_ejc_fez = selecaoEjc.numero_ejc_fez;
            merged.montagem_ejc_id = selecaoEjc.montagem_ejc_id;
        }

        merged.origem_ejc_tipo = (merged.origem_ejc_tipo === 'OUTRO_EJC') ? 'OUTRO_EJC' : 'INCONFIDENTES';
        if (merged.transferencia_outro_ejc) {
            merged.origem_ejc_tipo = 'INCONFIDENTES';
        }
        if (merged.origem_ejc_tipo === 'OUTRO_EJC') {
            merged.numero_ejc_fez = null;
            merged.montagem_ejc_id = null;
        } else {
            merged.outro_ejc_id = null;
            merged.outro_ejc_numero = null;
            merged.transferencia_outro_ejc = merged.transferencia_outro_ejc ? 1 : 0;
        }
        if (!merged.ja_foi_moita_inconfidentes) {
            merged.moita_ejc_id = null;
            merged.moita_funcao = null;
        }

        if (!merged.eh_musico) {
            merged.instrumentos_musicais = [];
        }

        let resolvedConjugeId = merged.conjuge_id || null;
        if (!resolvedConjugeId && merged.conjuge_nome) {
            try {
                const likeName = merged.conjuge_nome.trim();
                const phone = merged.conjuge_telefone || '';
                const [found] = await pool.query(
                    `SELECT id FROM jovens WHERE tenant_id = ? AND (nome_completo = ? OR telefone = ?) LIMIT 1`,
                    [tenantId, likeName, phone]
                );
                if (found && found.length) resolvedConjugeId = found[0].id;
                merged.conjuge_id = resolvedConjugeId;
            } catch (e) {
                resolvedConjugeId = merged.conjuge_id || null;
            }
        }

        const duplicidade = await validarDuplicidadeJovemListaMestre({
            tenantId,
            telefone: merged.telefone,
            email: merged.email,
            instagram: merged.instagram,
            excludeId: id
        });
        if (duplicidade) {
            return res.status(409).json({ error: duplicidade.error, campo: duplicidade.campo });
        }

        const [colCheck] = await pool.query(`
            SELECT COUNT(*) as cnt FROM information_schema.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jovens' AND COLUMN_NAME = 'conjuge_paroquia'
        `);
        const hasConjugeParoquia = (colCheck && colCheck[0] && colCheck[0].cnt > 0) || false;
        const hasConjugeEccTipo = await hasColumn('jovens', 'conjuge_ecc_tipo');
        const hasConjugeEccNumero = await hasColumn('jovens', 'conjuge_ecc_numero');
        const hasEhMusico = await hasEhMusicoColumn();
        const hasInstrumentosMusicais = await hasInstrumentosMusicaisColumn();
        const hasSexo = await hasSexoColumn();

        let updateFields = `nome_completo=?, apelido=?, telefone=?, email=?, data_nascimento=?, numero_ejc_fez=?, montagem_ejc_id=?, origem_ejc_tipo=?, outro_ejc_id=?, outro_ejc_numero=?, transferencia_outro_ejc=?, instagram=?, estado_civil=?, data_casamento=?, circulo=?, deficiencia=?, qual_deficiencia=?, restricao_alimentar=?, detalhes_restricao=?, endereco_rua=?, endereco_numero=?, endereco_bairro=?, endereco_cidade=?, endereco_cep=?, conjuge_id=?, conjuge_nome=?, conjuge_telefone=?, conjuge_ejc_id=?, conjuge_outro_ejc_id=?, observacoes_extras=?, nao_serve_ejc=?, motivo_nao_serve_ejc=?, ja_foi_moita_inconfidentes=?, moita_ejc_id=?, moita_funcao=?`;
        const params = [
            merged.nome_completo, merged.apelido || null, merged.telefone, merged.email || null, merged.data_nascimento, merged.numero_ejc_fez, merged.montagem_ejc_id || null, merged.origem_ejc_tipo, merged.outro_ejc_id || null, merged.outro_ejc_numero || null, merged.transferencia_outro_ejc ? 1 : 0,
            merged.instagram, merged.estado_civil, merged.data_casamento, merged.circulo, merged.deficiencia, merged.qual_deficiencia, merged.restricao_alimentar, merged.detalhes_restricao,
            merged.endereco_rua || null, merged.endereco_numero || null, merged.endereco_bairro || null, merged.endereco_cidade || null, merged.endereco_cep || null,
            merged.conjuge_id || null, merged.conjuge_nome || null, merged.conjuge_telefone || null, merged.conjuge_ejc_id || null, merged.conjuge_outro_ejc_id || null, merged.observacoes_extras || null,
            merged.nao_serve_ejc ? 1 : 0, merged.motivo_nao_serve_ejc || null,
            merged.ja_foi_moita_inconfidentes ? 1 : 0, merged.moita_ejc_id || null, merged.moita_funcao || null
        ];
        if (hasSexo) {
            updateFields += ', sexo=?';
            params.push((merged.sexo === 'Feminino' || merged.sexo === 'Masculino') ? merged.sexo : null);
        }
        if (hasConjugeParoquia) {
            updateFields += ', conjuge_paroquia=?';
            params.push(merged.conjuge_paroquia || null);
        }
        if (hasConjugeEccTipo) {
            updateFields += ', conjuge_ecc_tipo=?';
            params.push(merged.conjuge_ecc_tipo || null);
        }
        if (hasConjugeEccNumero) {
            updateFields += ', conjuge_ecc_numero=?';
            params.push(merged.conjuge_ecc_numero || null);
        }
        if (hasEhMusico) {
            updateFields += ', eh_musico=?';
            params.push(merged.eh_musico ? 1 : 0);
        }
        if (await hasEquipeSaudeColumn()) {
            updateFields += ', equipe_saude=?';
            params.push(merged.equipe_saude ? 1 : 0);
        }
        if (hasInstrumentosMusicais) {
            updateFields += ', instrumentos_musicais=?';
            params.push(serializarInstrumentos(merged.instrumentos_musicais, merged.eh_musico));
        }
        params.push(id, tenantId);

        const novoCasalId = merged.tio_casal_id ? Number(merged.tio_casal_id) : null;
        if (req.body.tio_casal_id !== undefined) {
            await ensureTiosVinculos();
            if (novoCasalId) {
                const [vinc] = await pool.query(
                    'SELECT casal_id FROM tios_jovens WHERE tenant_id = ? AND jovem_id = ? LIMIT 1',
                    [tenantId, id]
                );
                if (vinc.length && Number(vinc[0].casal_id) !== novoCasalId) {
                    return res.status(409).json({ error: 'Esse jovem já tem outro casal de tios.' });
                }
            }
        }

        await pool.query(`UPDATE jovens SET ${updateFields} WHERE id=? AND tenant_id = ?`, params);

        await vincularPresencasOutroEjcSemCadastro({
            tenantId,
            jovemId: Number(id),
            nomeAtual: merged.nome_completo,
            telefoneAtual: merged.telefone,
            outroEjcIdAtual: merged.outro_ejc_id,
            nomeOriginal: req.body.vincular_presencas_nome || atual.nome_completo,
            telefoneOriginal: req.body.vincular_presencas_telefone || atual.telefone,
            outroEjcIdOriginal: req.body.vincular_presencas_outro_ejc_id || atual.outro_ejc_id
        });

        if (req.body.tio_casal_id !== undefined) {
            if (novoCasalId) {
                await pool.query(
                    `INSERT INTO tios_jovens (tenant_id, casal_id, jovem_id)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE casal_id = VALUES(casal_id)`,
                    [tenantId, novoCasalId, id]
                );
            } else {
                await pool.query(
                    'DELETE FROM tios_jovens WHERE tenant_id = ? AND jovem_id = ?',
                    [tenantId, id]
                );
            }
        }

        // ... lógica de cônjuge (sincronização) ...
        const previousConjugeId = atual.conjuge_id || null;
        const newConjugeId = merged.conjuge_id || null;

        if (previousConjugeId && previousConjugeId !== newConjugeId) {
            let clearFields = 'conjuge_id=NULL, conjuge_nome=NULL, conjuge_telefone=NULL, conjuge_ejc_id=NULL, conjuge_outro_ejc_id=NULL';
            if (hasConjugeParoquia) clearFields += ', conjuge_paroquia=NULL';
            if (hasConjugeEccTipo) clearFields += ', conjuge_ecc_tipo=NULL';
            if (hasConjugeEccNumero) clearFields += ', conjuge_ecc_numero=NULL';
            if (!newConjugeId) {
                const [vinculoAtual] = await pool.query(
                    'SELECT conjuge_id FROM jovens WHERE id = ? AND tenant_id = ?',
                    [previousConjugeId, tenantId]
                );
                const estavaVinculadoComEsteJovem = vinculoAtual && vinculoAtual[0]
                    && Number(vinculoAtual[0].conjuge_id) === Number(id);
                if (estavaVinculadoComEsteJovem) {
                    clearFields += ", estado_civil='Solteiro', data_casamento=NULL";
                }
            }
            await pool.query(`UPDATE jovens SET ${clearFields} WHERE id = ? AND tenant_id = ?`, [previousConjugeId, tenantId]);
        }

        if (newConjugeId) {
            try {
                const [sp] = await pool.query('SELECT * FROM jovens WHERE id = ? AND tenant_id = ?', [newConjugeId, tenantId]);
                if (sp && sp.length) {
                    const parceiro = sp[0];
                    const parceiroEstado = parceiro.estado_civil;
                    const parceiroDataCasamento = parceiro.data_casamento;
                    const shouldAtualizarEstadoParceiro = parceiroEstado === 'Solteiro';
                    const estadoRelacaoAtual = (merged.estado_civil === 'Amasiado') ? 'Amasiado' : 'Casado';
                    const finalEstado = shouldAtualizarEstadoParceiro ? estadoRelacaoAtual : parceiroEstado;
                    const finalDataCasamento = merged.data_casamento || parceiroDataCasamento || null;

                    const partnerFields = [];
                    const partnerParams = [];
                    partnerFields.push('conjuge_id=?', 'conjuge_nome=?', 'conjuge_telefone=?', 'conjuge_ejc_id=?', 'conjuge_outro_ejc_id=?', 'estado_civil=?', 'data_casamento=?');
                    partnerParams.push(
                        id,
                        merged.nome_completo || atual.nome_completo,
                        merged.telefone || actualValueOrNull(atual.telefone),
                        null,
                        null,
                        finalEstado,
                        finalDataCasamento
                    );
                    if (hasConjugeEccTipo) {
                        partnerFields.push('conjuge_ecc_tipo=?');
                        partnerParams.push(merged.conjuge_ecc_tipo || null);
                    }
                    if (hasConjugeEccNumero) {
                        partnerFields.push('conjuge_ecc_numero=?');
                        partnerParams.push(merged.conjuge_ecc_numero || null);
                    }
                    partnerParams.push(newConjugeId, tenantId);
                    await pool.query(
                        `UPDATE jovens SET ${partnerFields.join(', ')} WHERE id=? AND tenant_id = ?`,
                        partnerParams
                    );

                    const deveMoverCasalParaTios = req.body && (
                        req.body.mover_casal_para_tios === true
                        || req.body.mover_casal_para_tios === 1
                        || req.body.mover_casal_para_tios === '1'
                        || req.body.mover_casal_para_tios === 'true'
                    );
                    const eccTipo = merged.conjuge_ecc_tipo;
                    const eccNumero = merged.conjuge_ecc_numero;
                    if (deveMoverCasalParaTios) {
                        try {
                            await ensureListaMestreAtivoColumn();
                            await pool.query(
                                `UPDATE jovens
                                 SET lista_mestre_ativo = 0,
                                     circulo = NULL
                                 WHERE tenant_id = ?
                                   AND id IN (?, ?)`,
                                [tenantId, Number(id), Number(newConjugeId)]
                            );
                            removidosDaListaMestre.push(Number(id), Number(newConjugeId));
                        } catch (e) {
                            console.error('Erro ao remover casal da Lista Mestre:', e);
                        }

                        try {
                            if (eccTipo && (eccTipo === 'ECC' || eccTipo === 'ECNA') && eccNumero) {
                                await upsertCasalParaTios({
                                    tenantId,
                                    eccNumero,
                                    eccTipo,
                                    principal: {
                                        nome_completo: merged.nome_completo || atual.nome_completo || '',
                                        telefone: merged.telefone || atual.telefone || '',
                                        data_nascimento: merged.data_nascimento || atual.data_nascimento || null,
                                        sexo: merged.sexo || atual.sexo || ''
                                    },
                                    conjuge: parceiro
                                });
                            }
                        } catch (e) {
                            console.error('Erro ao cadastrar casal em tios:', e);
                        }
                    }
                }
            } catch (e) {
                console.error('Erro ao sincronizar cônjuge:', e);
            }
        }

        if (merged.estado_civil === 'Solteiro') {
            const linkedId = atual.conjuge_id || merged.conjuge_id || null;
            try {
                if (linkedId) {
                let clearPartnerFields = "conjuge_id=NULL, conjuge_nome=NULL, conjuge_telefone=NULL, conjuge_ejc_id=NULL, conjuge_outro_ejc_id=NULL";
                if (hasConjugeParoquia) clearPartnerFields += ', conjuge_paroquia=NULL';
                if (hasConjugeEccTipo) clearPartnerFields += ', conjuge_ecc_tipo=NULL';
                if (hasConjugeEccNumero) clearPartnerFields += ', conjuge_ecc_numero=NULL';
                    clearPartnerFields += ", estado_civil='Solteiro', data_casamento=NULL";
                    await pool.query(
                        `UPDATE jovens SET ${clearPartnerFields} WHERE id = ? AND tenant_id = ?`,
                        [linkedId, tenantId]
                    );
                }
                let clearSelfFields = 'conjuge_id=NULL, conjuge_nome=NULL, conjuge_telefone=NULL, conjuge_ejc_id=NULL, conjuge_outro_ejc_id=NULL';
                if (hasConjugeParoquia) clearSelfFields += ', conjuge_paroquia=NULL';
                if (hasConjugeEccTipo) clearSelfFields += ', conjuge_ecc_tipo=NULL';
                if (hasConjugeEccNumero) clearSelfFields += ', conjuge_ecc_numero=NULL';
                await pool.query(`UPDATE jovens SET ${clearSelfFields} WHERE id = ? AND tenant_id = ?`, [id, tenantId]);
            } catch (e) {
                console.error('Erro ao desfazer vínculos de cônjuge:', e);
            }
        }

        res.json({
            message: "Jovem atualizado com sucesso",
            removidos_da_lista_mestre: Array.from(new Set(removidosDaListaMestre.filter((item) => Number.isInteger(item) && item > 0)))
        });
    } catch (err) {
        console.error("Erro ao atualizar jovem:", err);
        res.status(500).json({ error: "Erro ao salvar alterações" });
    }
});

router.patch('/:id/status-lista', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const id = Number(req.params.id);
        const ativo = req.body && (req.body.ativo === true || req.body.ativo === 1 || req.body.ativo === '1');
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'Jovem inválido.' });
        }
        await ensureListaMestreAtivoColumn();
        const [result] = await pool.query(
            `UPDATE jovens
             SET lista_mestre_ativo = ?
             WHERE id = ? AND tenant_id = ?`,
            [ativo ? 1 : 0, id, tenantId]
        );
        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Jovem não encontrado.' });
        }
        return res.json({ message: ativo ? 'Jovem reativado na Lista Mestre.' : 'Jovem removido da Lista Mestre.' });
    } catch (err) {
        console.error('Erro ao atualizar status da Lista Mestre:', err);
        return res.status(500).json({ error: 'Erro ao atualizar status da Lista Mestre.' });
    }
});


// DELETE - Deletar jovem
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const tenantId = getTenantId(req);
        await ensureHistoricoEquipesSnapshots();
        await ensureHistoricoEquipesYoungFkPreserved();
        await ensureEjcEncontristasHistoricoTable();
        await backfillHistoricoEquipesSnapshots({ tenantId, jovemId: id });

        // Deletar a imagem caso exista
        const [rows] = await pool.query('SELECT foto_url FROM jovens WHERE id = ? AND tenant_id = ?', [id, tenantId]);
        if (rows.length > 0 && rows[0].foto_url) {
            const filepath = path.join(__dirname, '..', 'public', rows[0].foto_url);
            if (fs.existsSync(filepath)) {
                fs.unlinkSync(filepath);
            }
        }

        const [result] = await pool.query('DELETE FROM jovens WHERE id = ? AND tenant_id = ?', [id, tenantId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Jovem não encontrado" });
        }

        res.json({ message: "Jovem deletado com sucesso" });
    } catch (err) {
        console.error("Erro ao deletar jovem:", err);
        res.status(500).json({ error: "Erro ao deletar jovem" });
    }
});

// POST - Upload da foto do Jovem
router.post('/:id/foto', (req, res) => {
    upload.single('foto')(req, res, async (uploadErr) => {
        if (uploadErr) {
            console.error('Erro no upload da foto:', uploadErr);
            return res.status(400).json({ error: 'Não foi possível enviar a foto.' });
        }
        if (!req.file) return res.status(400).json({ error: "Nenhuma imagem selecionada" });

        const { id } = req.params;
        const fotoUrl = `/uploads/fotos_jovens/${req.file.filename}`;

        try {
            const tenantId = getTenantId(req);
            // Obter a foto anterior, se existir, para deletar
            const [rows] = await pool.query('SELECT foto_url FROM jovens WHERE id = ? AND tenant_id = ?', [id, tenantId]);
            if (rows.length > 0 && rows[0].foto_url) {
                const relativeFoto = String(rows[0].foto_url).replace(/^\/+/, '');
                const filepath = path.join(__dirname, '..', 'public', relativeFoto);
                if (fs.existsSync(filepath)) {
                    try {
                        fs.unlinkSync(filepath);
                    } catch (e) {
                        console.error("Não foi possível excluir foto anterior", e);
                    }
                }
            }

            // Atualizar banco
            const [result] = await pool.query('UPDATE jovens SET foto_url = ? WHERE id = ? AND tenant_id = ?', [fotoUrl, id, tenantId]);

            if (result.affectedRows === 0) {
                // Se o jovem não existe, exclui a foto upada e retorna erro
                if (req.file.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
                return res.status(404).json({ error: 'Jovem não encontrado' });
            }

            return res.json({ message: 'Foto salva com sucesso', foto_url: fotoUrl });
        } catch (err) {
            console.error("Erro ao salvar foto do jovem:", err);
            return res.status(500).json({ error: "Erro ao salvar foto" });
        }
    });
});

// POST - Importação
router.post('/importacao', async (req, res) => {
    const dados = req.body;
    if (!Array.isArray(dados)) return res.status(400).json({ error: "Formato inválido" });

    let criados = 0;
    let atualizados = 0;
    let erros = 0;
    const detalhesErros = [];

    const connection = await pool.getConnection();

    try {
        const tenantId = getTenantId(req);
        await ensureEmailColumn();
        await ensureApelidoColumn();
        await ensureEnderecoColumns();
        await ensureEquipeSaudeColumn();
        await ensureNaoServeEjcColumns();
        const hasHistorico = await hasTable('historico_equipes');
        const comSubfuncao = await hasSubfuncaoColumn();
        const comSexo = await hasSexoColumn();
        const comEhMusico = await hasEhMusicoColumn();
        const comInstrumentos = await hasInstrumentosMusicaisColumn();
        const [ejcsRows] = await connection.query('SELECT id, numero FROM ejc WHERE tenant_id = ?', [tenantId]);
        const ejcIdsValidos = new Set((ejcsRows || []).map(r => Number(r.id)).filter(n => Number.isFinite(n)));
        const ejcNumeroParaId = new Map();
        (ejcsRows || []).forEach((r) => {
            const numero = Number(r.numero);
            const id = Number(r.id);
            if (Number.isFinite(numero) && Number.isFinite(id)) {
                ejcNumeroParaId.set(numero, id);
            }
        });

        const resolverEjcId = (valorOriginal) => {
            if (valorOriginal === undefined || valorOriginal === null || valorOriginal === '') return null;
            const valor = Number(valorOriginal);
            if (!Number.isFinite(valor)) return null;
            if (ejcIdsValidos.has(valor)) return valor;
            if (ejcNumeroParaId.has(valor)) return ejcNumeroParaId.get(valor);
            return null;
        };
        const estadosCivisValidos = new Set(['Solteiro', 'Casado', 'Amasiado']);
        const sexosValidos = new Set(['Feminino', 'Masculino']);
        let circulosValidos = new Set();
        try {
            const hasCirculos = await hasTable('circulos');
            if (hasCirculos) {
                const [rowsCirculos] = await connection.query(`
                    SELECT nome
                    FROM circulos
                    WHERE ativo = 1
                      AND tenant_id = ?
                    ORDER BY ordem ASC, nome ASC
                `, [tenantId]);
                const lista = (rowsCirculos || [])
                    .map(r => String(r.nome || '').trim())
                    .filter(Boolean);
                circulosValidos = new Set(lista);
            }
        } catch (_) { }
        const ehDataIsoValida = (valor) => {
            if (!valor) return true;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(String(valor))) return false;
            const d = new Date(`${valor}T00:00:00Z`);
            return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === valor;
        };
        const ehDataHoraValida = (valor) => {
            if (!valor) return true;
            const texto = String(valor).trim();
            if (!texto) return true;
            if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) return ehDataIsoValida(texto);
            if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(texto)) return false;
            const normalizado = texto.replace(' ', 'T');
            const d = new Date(normalizado);
            return !Number.isNaN(d.getTime());
        };
        const normalizarTextoOuNull = (valor, maxLen = null) => {
            if (valor === undefined || valor === null) return null;
            const texto = String(valor).trim();
            if (!texto) return null;
            if (maxLen && texto.length > maxLen) {
                throw new Error(`Campo texto fora do padrão: máximo de ${maxLen} caracteres.`);
            }
            return texto;
        };
        const normalizarJovemImportacao = (j) => {
            if (!j || typeof j !== 'object') throw new Error('Registro de jovem inválido.');

            j.nome_completo = String(j.nome_completo || '').trim();
            if (!j.nome_completo) throw new Error('Campo nome é obrigatório.');
            if (j.nome_completo.length > 120) throw new Error('Campo nome_completo fora do padrão: máximo de 120 caracteres.');

            if (j.telefone !== undefined && j.telefone !== null && String(j.telefone).trim() !== '') {
                const telefoneTexto = String(j.telefone).trim();
                const digitos = telefoneTexto.replace(/\D/g, '');
                if (digitos.length < 10 || digitos.length > 11) {
                    throw new Error(`Campo telefone fora do padrão: "${telefoneTexto}". Padrão normal: 10 ou 11 dígitos.`);
                }
                j.telefone = telefoneTexto;
            } else {
                j.telefone = null;
            }

            if (j.estado_civil === undefined || j.estado_civil === null || String(j.estado_civil).trim() === '') {
                j.estado_civil = 'Solteiro';
            } else {
                j.estado_civil = String(j.estado_civil).trim();
                if (!estadosCivisValidos.has(j.estado_civil)) {
                    throw new Error(`Campo estado_civil fora do padrão: "${j.estado_civil}". Padrão normal: Solteiro, Casado ou Amasiado.`);
                }
            }

            if (j.sexo === undefined || j.sexo === null || String(j.sexo).trim() === '') {
                j.sexo = null;
            } else {
                j.sexo = String(j.sexo).trim();
                if (!sexosValidos.has(j.sexo)) {
                    throw new Error(`Campo sexo fora do padrão: "${j.sexo}". Padrão normal: Feminino ou Masculino.`);
                }
            }

            if (j.circulo === undefined || j.circulo === null || String(j.circulo).trim() === '') {
                j.circulo = null;
            } else {
                j.circulo = String(j.circulo).trim();
                if (!circulosValidos.size) {
                    throw new Error('Nenhuma cor de círculo está cadastrada. Cadastre em Configurações > Círculos.');
                }
                if (!circulosValidos.has(j.circulo)) {
                    throw new Error(`Campo circulo fora do padrão: "${j.circulo}". Padrão normal: ${Array.from(circulosValidos).join(', ')}.`);
                }
            }

            if (!ehDataIsoValida(j.data_nascimento)) {
                throw new Error(`Campo data_nascimento fora do padrão: "${j.data_nascimento}". Padrão normal: AAAA-MM-DD.`);
            }
            if (!ehDataIsoValida(j.data_casamento)) {
                throw new Error(`Campo data_casamento fora do padrão: "${j.data_casamento}". Padrão normal: AAAA-MM-DD.`);
            }
            if (!ehDataHoraValida(j.termos_aceitos_em)) {
                throw new Error(`Campo termos_aceitos_em fora do padrão: "${j.termos_aceitos_em}". Padrão normal: AAAA-MM-DD HH:mm:ss.`);
            }

            if (j.restricao_alimentar !== undefined && j.restricao_alimentar !== null && typeof j.restricao_alimentar !== 'boolean') {
                throw new Error('Campo restricao_alimentar fora do padrão: use apenas Sim/Não.');
            }
            if (j.deficiencia !== undefined && j.deficiencia !== null && typeof j.deficiencia !== 'boolean') {
                throw new Error('Campo deficiencia fora do padrão: use apenas Sim/Não.');
            }
            if (j.eh_musico !== undefined && j.eh_musico !== null && typeof j.eh_musico !== 'boolean') {
                throw new Error('Campo eh_musico fora do padrão: use apenas Sim/Não.');
            }
            if (j.equipe_saude !== undefined && j.equipe_saude !== null && typeof j.equipe_saude !== 'boolean') {
                throw new Error('Campo equipe_saude fora do padrão: use apenas Sim/Não.');
            }
            if (j.nao_serve_ejc !== undefined && j.nao_serve_ejc !== null && typeof j.nao_serve_ejc !== 'boolean') {
                throw new Error('Campo nao_serve_ejc fora do padrão: use apenas Sim/Não.');
            }

            const numeroEjcOriginal = j.numero_ejc_fez;
            j.numero_ejc_fez = resolverEjcId(j.numero_ejc_fez);
            if (numeroEjcOriginal !== undefined && numeroEjcOriginal !== null && String(numeroEjcOriginal).trim() !== '' && !j.numero_ejc_fez) {
                throw new Error(`Campo numero_ejc fora do padrão: "${numeroEjcOriginal}". Informe um EJC existente.`);
            }

            j.apelido = normalizarTextoOuNull(j.apelido, 120);
            j.email = normalizarTextoOuNull(j.email, 180);
            j.instagram = normalizarTextoOuNull(j.instagram, 100);
            j.qual_deficiencia = normalizarTextoOuNull(j.qual_deficiencia, 150);
            j.detalhes_restricao = normalizarTextoOuNull(j.detalhes_restricao, 255);
            j.conjuge_nome = normalizarTextoOuNull(j.conjuge_nome, 150);
            j.termos_aceitos_email = normalizarTextoOuNull(j.termos_aceitos_email, 180);
            j.motivo_nao_serve_ejc = normalizarTextoOuNull(j.motivo_nao_serve_ejc);
            j.endereco_rua = normalizarTextoOuNull(j.endereco_rua, 180);
            j.endereco_numero = normalizarTextoOuNull(j.endereco_numero, 30);
            j.endereco_bairro = normalizarTextoOuNull(j.endereco_bairro, 120);
            j.endereco_cidade = normalizarTextoOuNull(j.endereco_cidade, 120);
            j.endereco_cep = normalizarTextoOuNull(j.endereco_cep, 12);
            if (j.nao_serve_ejc === false) {
                j.motivo_nao_serve_ejc = '';
            }
            if (j.eh_musico) {
                if (Array.isArray(j.instrumentos_musicais)) {
                    j.instrumentos_musicais = j.instrumentos_musicais.map((item) => String(item || '').trim()).filter(Boolean);
                } else if (j.instrumentos_musicais !== undefined && j.instrumentos_musicais !== null && String(j.instrumentos_musicais).trim() !== '') {
                    j.instrumentos_musicais = String(j.instrumentos_musicais).split(',').map((item) => item.trim()).filter(Boolean);
                } else {
                    j.instrumentos_musicais = [];
                }
            } else {
                j.instrumentos_musicais = [];
            }
        };

        for (let i = 0; i < dados.length; i++) {
            const item = dados[i];
            let nomeJovem = 'Registro sem nome';
            try {
                const j = item && item.jovem ? item.jovem : null;
                const nomeBase = j ? (j.nome_completo || j.nome || j.full_name || '') : '';
                const nomeFinal = String(nomeBase || '').trim();
                if (!j || !nomeFinal) {
                    continue;
                }
                j.nome_completo = nomeFinal;
                nomeJovem = j.nome_completo || nomeJovem;
                normalizarJovemImportacao(j);
                let jovemId = null;

                const [exists] = await connection.query(
                    'SELECT id FROM jovens WHERE tenant_id = ? AND (nome_completo = ? OR (telefone = ? AND telefone IS NOT NULL AND telefone != "")) LIMIT 1',
                    [tenantId, j.nome_completo, j.telefone]
                );

                const duplicidade = await validarDuplicidadeJovemListaMestre({
                    tenantId,
                    telefone: j.telefone,
                    email: j.email,
                    instagram: j.instagram,
                    excludeId: exists.length > 0 ? exists[0].id : null,
                    connection
                });
                if (duplicidade) {
                    throw new Error(`${nomeJovem}: ${duplicidade.error}`);
                }

                if (exists.length > 0) {
                    jovemId = exists[0].id;
                    let updateSql = `UPDATE jovens SET
                            telefone = COALESCE(?, telefone),
                            apelido = COALESCE(?, apelido),
                            email = COALESCE(?, email),
                            data_nascimento = COALESCE(?, data_nascimento),
                            numero_ejc_fez = COALESCE(?, numero_ejc_fez),
                            instagram = COALESCE(?, instagram),
                            estado_civil = COALESCE(?, estado_civil),
                            data_casamento = COALESCE(?, data_casamento),
                            circulo = COALESCE(?, circulo),
                            deficiencia = COALESCE(?, deficiencia),
                            qual_deficiencia = COALESCE(?, qual_deficiencia),
                            restricao_alimentar = COALESCE(?, restricao_alimentar),
                            detalhes_restricao = COALESCE(?, detalhes_restricao),
                            conjuge_nome = COALESCE(?, conjuge_nome),
                            termos_aceitos_em = COALESCE(?, termos_aceitos_em),
                            termos_aceitos_email = COALESCE(?, termos_aceitos_email),
                            endereco_rua = COALESCE(?, endereco_rua),
                            endereco_numero = COALESCE(?, endereco_numero),
                            endereco_bairro = COALESCE(?, endereco_bairro),
                            endereco_cidade = COALESCE(?, endereco_cidade),
                            endereco_cep = COALESCE(?, endereco_cep),
                            nao_serve_ejc = COALESCE(?, nao_serve_ejc),
                            motivo_nao_serve_ejc = COALESCE(?, motivo_nao_serve_ejc),
                            equipe_saude = COALESCE(?, equipe_saude)`;
                    const updateParams = [
                        j.telefone, j.apelido, j.email, j.data_nascimento, j.numero_ejc_fez, j.instagram,
                        j.estado_civil, j.data_casamento, j.circulo, j.deficiencia, j.qual_deficiencia,
                        j.restricao_alimentar, j.detalhes_restricao, j.conjuge_nome, j.termos_aceitos_em,
                        j.termos_aceitos_email, j.endereco_rua, j.endereco_numero, j.endereco_bairro,
                        j.endereco_cidade, j.endereco_cep, j.nao_serve_ejc, j.motivo_nao_serve_ejc, j.equipe_saude
                    ];
                    if (comSexo) {
                        updateSql += ', sexo = COALESCE(?, sexo)';
                        updateParams.push(j.sexo);
                    }
                    if (comEhMusico) {
                        updateSql += ', eh_musico = COALESCE(?, eh_musico)';
                        updateParams.push(j.eh_musico);
                    }
                    if (comInstrumentos) {
                        updateSql += ', instrumentos_musicais = COALESCE(?, instrumentos_musicais)';
                        updateParams.push(j.eh_musico === null || j.eh_musico === undefined ? null : (j.eh_musico ? JSON.stringify(j.instrumentos_musicais || []) : '[]'));
                    }
                    updateSql += ' WHERE id = ? AND tenant_id = ?';
                    updateParams.push(jovemId, tenantId);
                    await connection.query(updateSql, updateParams);
                    atualizados++;
                } else {
                    const insertFields = [
                        'tenant_id', 'nome_completo', 'telefone', 'apelido', 'email', 'data_nascimento',
                        'numero_ejc_fez', 'instagram', 'estado_civil', 'data_casamento', 'circulo',
                        'deficiencia', 'qual_deficiencia', 'restricao_alimentar', 'detalhes_restricao',
                        'conjuge_nome', 'termos_aceitos_em', 'termos_aceitos_email', 'endereco_rua',
                        'endereco_numero', 'endereco_bairro', 'endereco_cidade', 'endereco_cep',
                        'nao_serve_ejc', 'motivo_nao_serve_ejc', 'equipe_saude'
                    ];
                    const insertParams = [
                        tenantId, j.nome_completo, j.telefone, j.apelido, j.email, j.data_nascimento,
                        j.numero_ejc_fez, j.instagram, j.estado_civil, j.data_casamento, j.circulo,
                        j.deficiencia ? 1 : 0, j.qual_deficiencia, j.restricao_alimentar ? 1 : 0,
                        j.detalhes_restricao, j.conjuge_nome, j.termos_aceitos_em, j.termos_aceitos_email,
                        j.endereco_rua, j.endereco_numero, j.endereco_bairro, j.endereco_cidade,
                        j.endereco_cep, j.nao_serve_ejc ? 1 : 0, j.motivo_nao_serve_ejc, j.equipe_saude ? 1 : 0
                    ];
                    if (comSexo) {
                        insertFields.push('sexo');
                        insertParams.push(j.sexo);
                    }
                    if (comEhMusico) {
                        insertFields.push('eh_musico');
                        insertParams.push(j.eh_musico ? 1 : 0);
                    }
                    if (comInstrumentos) {
                        insertFields.push('instrumentos_musicais');
                        insertParams.push(j.eh_musico ? JSON.stringify(j.instrumentos_musicais || []) : '[]');
                    }
                    const insertSql = `INSERT INTO jovens (${insertFields.join(', ')})
                        VALUES (${insertFields.map(() => '?').join(', ')})`;
                    const [resInsert] = await connection.query(insertSql, insertParams);
                    jovemId = resInsert.insertId;
                    criados++;
                }

                if (hasHistorico && item.historico && item.historico.length > 0) {
                    for (const hist of item.historico) {
                        const papelHist = hist.papel || 'Membro';
                        const subfuncaoHist = hist.subfuncao || null;
                        const [histExists] = await connection.query(
                            comSubfuncao
                                ? 'SELECT id FROM historico_equipes WHERE tenant_id = ? AND jovem_id = ? AND ejc_id = ? AND equipe = ? AND papel = ? AND (subfuncao <=> ?)'
                                : 'SELECT id FROM historico_equipes WHERE tenant_id = ? AND jovem_id = ? AND ejc_id = ? AND equipe = ? AND papel = ?',
                            comSubfuncao
                                ? [tenantId, jovemId, hist.ejc_id, hist.equipe, papelHist, subfuncaoHist]
                                : [tenantId, jovemId, hist.ejc_id, hist.equipe, papelHist]
                        );

                        if (histExists.length === 0) {
                            if (comSubfuncao) {
                                await connection.query(
                                    'INSERT INTO historico_equipes (tenant_id, jovem_id, equipe, ejc_id, papel, subfuncao) VALUES (?, ?, ?, ?, ?, ?)',
                                    [tenantId, jovemId, hist.equipe, hist.ejc_id, papelHist, subfuncaoHist]
                                );
                            } else {
                                await connection.query(
                                    'INSERT INTO historico_equipes (tenant_id, jovem_id, equipe, ejc_id, papel) VALUES (?, ?, ?, ?, ?)',
                                    [tenantId, jovemId, hist.equipe, hist.ejc_id, papelHist]
                                );
                            }
                        }
                    }
                }

            } catch (errInner) {
                const mensagem = errInner && (errInner.sqlMessage || errInner.message)
                    ? (errInner.sqlMessage || errInner.message)
                    : 'Erro desconhecido durante importação.';
                console.error("Erro ao importar item:", nomeJovem, errInner);
                erros++;
                detalhesErros.push({
                    linha: i + 2,
                    nome: nomeJovem,
                    erro: mensagem
                });
            }
        }
        res.json({
            message: "Importação concluída",
            resumo: { criados, atualizados, erros },
            detalhesErros
        });
    } catch (err) {
        console.error("Erro geral na importação:", err);
        res.status(500).json({
            error: err && (err.sqlMessage || err.message)
                ? (err.sqlMessage || err.message)
                : "Erro no servidor durante importação"
        });
    } finally {
        connection.release();
    }
});

// GET - Histórico de equipes de um jovem
router.get('/historico/:jovemId', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const jovemId = Number(req.params.jovemId);
        if (!Number.isInteger(jovemId) || jovemId <= 0) {
            return res.status(400).json({ error: 'Jovem inválido.' });
        }
        await ensureHistoricoEquipesSnapshots();
        await ensureHistoricoEquipesYoungFkPreserved();
        await backfillHistoricoEquipesSnapshots({ tenantId, jovemId });
        const comCreatedAt = await hasHistoricoCreatedAtColumn();
        const orderBy = comCreatedAt ? 'he.created_at DESC' : 'he.id DESC';
        const [rows] = await pool.query(`
            SELECT 
                he.*, 
                COALESCE(e.numero, he.edicao_ejc) as display_ejc,
                e.paroquia as paroquia_ejc
            FROM historico_equipes he 
            LEFT JOIN ejc e ON he.ejc_id = e.id AND e.tenant_id = he.tenant_id
            WHERE he.jovem_id = ?
              AND he.tenant_id = ?
            ORDER BY ${orderBy}
        `, [jovemId, tenantId]);

        const [montagensRows] = await pool.query(`
            SELECT id, numero_ejc, COALESCE(data_fim, data_encontro) AS data_limite
            FROM montagens
            WHERE tenant_id = ?
        `, [tenantId]);
        const limitePorNumero = new Map();
        const montagemAtivaPorNumero = new Map();
        for (const m of montagensRows || []) {
            if (!m || m.numero_ejc === null || m.numero_ejc === undefined) continue;
            const numero = Number(m.numero_ejc);
            if (!Number.isFinite(numero)) continue;
            if (!montagemAtivaPorNumero.has(numero) && m.id) {
                montagemAtivaPorNumero.set(numero, Number(m.id));
            }
            const limite = m.data_limite ? String(m.data_limite).split('T')[0] : null;
            if (!limite) continue;
            const atual = limitePorNumero.get(numero);
            if (!atual || limite > atual) limitePorNumero.set(numero, limite);
        }

        const hoje = new Date();
        const hojeIso = new Date(Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()))
            .toISOString()
            .split('T')[0];

        const normalizados = rows.map((r) => {
            const item = { ...r };
            const texto = item.display_ejc == null ? '' : String(item.display_ejc).trim();
            const m = texto.match(/^(\d+)\s*[ºo°]?\s*EJC\s*\(Montagem\)\s*$/i);
            if (!m) {
                const ejcNumero = Number(item.display_ejc);
                const numeroTexto = texto.match(/^(\d+)\s*[ºo°]?\s*EJC\s*$/i);
                const numero = Number.isFinite(ejcNumero) && ejcNumero > 0
                    ? ejcNumero
                    : (numeroTexto ? Number(numeroTexto[1]) : NaN);
                if (Number.isFinite(numero) && montagemAtivaPorNumero.has(numero)) {
                    item.display_ejc = montarEtiquetaEdicao(numero);
                    item.origem = item.origem || 'montagem';
                    item.montagem_id = item.montagem_id || montagemAtivaPorNumero.get(numero);
                }
                return item;
            }

            const numero = Number(m[1]);
            const limite = limitePorNumero.get(numero);
            if (!limite || limite >= hojeIso) return item;

            item.display_ejc = `${numero}º EJC`;
            return item;
        });

        const [montagemRows] = await pool.query(`
            SELECT
                mm.id AS montagem_membro_id,
                mm.montagem_id,
                mm.eh_substituicao,
                mm.status_ligacao,
                m.numero_ejc,
                e.nome AS equipe,
                ef.nome AS funcao_nome
            FROM montagem_membros mm
            INNER JOIN montagens m ON m.id = mm.montagem_id AND m.tenant_id = mm.tenant_id
            INNER JOIN equipes e ON e.id = mm.equipe_id AND e.tenant_id = mm.tenant_id
            LEFT JOIN equipes_funcoes ef ON ef.id = mm.funcao_id
            WHERE mm.jovem_id = ?
              AND mm.tenant_id = ?
              AND COALESCE(mm.status_ligacao, '') <> 'RECUSOU'
            ORDER BY m.numero_ejc DESC, mm.eh_substituicao ASC, mm.id DESC
        `, [jovemId, tenantId]);

        const itens = [];
        const chaves = new Set();
        const adicionarItem = (item) => {
            if (!item) return;
            const chave = [
                String(item.display_ejc || '').trim().toLowerCase(),
                String(item.nome_equipe || item.equipe || '').trim().toLowerCase(),
                String(item.papel || '').trim().toLowerCase(),
                String(item.subfuncao || '').trim().toLowerCase()
            ].join('|');
            if (chaves.has(chave)) return;
            chaves.add(chave);
            itens.push(item);
        };

        for (const row of (montagemRows || [])) {
            adicionarItem({
                id: `montagem-${row.montagem_membro_id}`,
                jovem_id: jovemId,
                equipe: row.equipe,
                nome_equipe: row.equipe,
                papel: row.eh_substituicao ? 'Reserva' : mapearPapelPorNomeFuncao(row.funcao_nome),
                subfuncao: row.funcao_nome || null,
                display_ejc: montarEtiquetaEdicao(row.numero_ejc),
                paroquia_ejc: null,
                origem: 'montagem',
                montagem_id: row.montagem_id,
                eh_substituicao: Number(row.eh_substituicao || 0)
            });
        }

        for (const row of normalizados) {
            adicionarItem(row);
        }

        if (!montagemRows.length) {
            const [[jovemMontagem]] = await pool.query(`
                SELECT j.montagem_ejc_id, m.numero_ejc
                FROM jovens j
                LEFT JOIN montagens m ON m.id = j.montagem_ejc_id AND m.tenant_id = j.tenant_id
                WHERE j.id = ? AND j.tenant_id = ?
                LIMIT 1
            `, [jovemId, tenantId]);

            if (jovemMontagem && jovemMontagem.montagem_ejc_id && jovemMontagem.numero_ejc) {
                adicionarItem({
                    id: `montagem-atual-${jovemMontagem.montagem_ejc_id}`,
                    jovem_id: jovemId,
                    equipe: 'A definir',
                    nome_equipe: 'A definir',
                    papel: 'Encontrista',
                    subfuncao: 'Montagem atual',
                    display_ejc: montarEtiquetaEdicao(jovemMontagem.numero_ejc),
                    paroquia_ejc: null,
                    origem: 'montagem',
                    montagem_id: jovemMontagem.montagem_ejc_id,
                    eh_substituicao: 0
                });
            }
        }

        res.json(itens);
    } catch (err) {
        console.error("Erro ao buscar histórico:", err);
        res.status(500).json({ error: "Erro no servidor" });
    }
});

// POST - Adicionar histórico manualmente
router.post('/historico', async (req, res) => {
    const { jovem_id, equipe_nome, ejc_id, papel, subfuncao } = req.body;

    if (!jovem_id || !equipe_nome || !ejc_id) {
        return res.status(400).json({ error: "Jovem, Equipe e EJC são obrigatórios" });
    }

    try {
        const tenantId = getTenantId(req);
        await ensureHistoricoEquipesSnapshots();
        await ensureHistoricoEquipesYoungFkPreserved();
        const comSubfuncao = await hasSubfuncaoColumn();
        const [[jovem]] = await pool.query(`
            SELECT
                j.nome_completo,
                j.telefone,
                COALESCE(j.origem_ejc_tipo, 'INCONFIDENTES') AS origem_ejc_tipo,
                j.outro_ejc_numero,
                j.outro_ejc_id,
                oe.nome AS outro_ejc_nome,
                oe.paroquia AS outro_ejc_paroquia
            FROM jovens j
            LEFT JOIN outros_ejcs oe
              ON oe.id = j.outro_ejc_id
             AND oe.tenant_id = j.tenant_id
            WHERE j.id = ?
              AND j.tenant_id = ?
            LIMIT 1
        `, [jovem_id, tenantId]);
        const [result] = comSubfuncao
            ? await pool.query(
                `INSERT INTO historico_equipes (
                    tenant_id, jovem_id, equipe, ejc_id, papel, subfuncao,
                    nome_completo_snapshot, telefone_snapshot, origem_ejc_tipo_snapshot,
                    outro_ejc_numero_snapshot, outro_ejc_id_snapshot, outro_ejc_nome_snapshot, outro_ejc_paroquia_snapshot
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    tenantId,
                    jovem_id,
                    equipe_nome,
                    ejc_id,
                    papel || 'Membro',
                    subfuncao || null,
                    jovem ? (jovem.nome_completo || null) : null,
                    jovem ? (jovem.telefone || null) : null,
                    jovem ? (jovem.origem_ejc_tipo || 'INCONFIDENTES') : 'INCONFIDENTES',
                    jovem ? (jovem.outro_ejc_numero || null) : null,
                    jovem ? (jovem.outro_ejc_id || null) : null,
                    jovem ? (jovem.outro_ejc_nome || null) : null,
                    jovem ? (jovem.outro_ejc_paroquia || null) : null
                ]
            )
            : await pool.query(
                `INSERT INTO historico_equipes (
                    tenant_id, jovem_id, equipe, ejc_id, papel,
                    nome_completo_snapshot, telefone_snapshot, origem_ejc_tipo_snapshot,
                    outro_ejc_numero_snapshot, outro_ejc_id_snapshot, outro_ejc_nome_snapshot, outro_ejc_paroquia_snapshot
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    tenantId,
                    jovem_id,
                    equipe_nome,
                    ejc_id,
                    papel || 'Membro',
                    jovem ? (jovem.nome_completo || null) : null,
                    jovem ? (jovem.telefone || null) : null,
                    jovem ? (jovem.origem_ejc_tipo || 'INCONFIDENTES') : 'INCONFIDENTES',
                    jovem ? (jovem.outro_ejc_numero || null) : null,
                    jovem ? (jovem.outro_ejc_id || null) : null,
                    jovem ? (jovem.outro_ejc_nome || null) : null,
                    jovem ? (jovem.outro_ejc_paroquia || null) : null
                ]
            );
        res.json({ id: result.insertId, message: "Equipe adicionada ao histórico com sucesso" });
    } catch (err) {
        console.error("Erro ao adicionar histórico:", err);
        res.status(500).json({ error: "Erro ao adicionar equipe ao histórico" });
    }
});

// DELETE - Remover histórico
router.delete('/historico/:id', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const [result] = await pool.query('DELETE FROM historico_equipes WHERE id = ? AND tenant_id = ?', [req.params.id, tenantId]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Registro não encontrado" });
        }
        res.json({ message: "Histórico removido com sucesso" });
    } catch (err) {
        console.error("Erro ao remover histórico:", err);
        res.status(500).json({ error: "Erro ao remover histórico" });
    }
});

// --- COMISSÕES / HISTÓRICO EXTERNO ---

// GET - Listar comissões de um jovem
router.get('/comissoes/:jovemId', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const [rows] = await pool.query(`
            SELECT 
                jc.*,
                oe.nome as outro_ejc_nome,
                oe.paroquia as outro_ejc_paroquia,
                c.periodo AS coordenacao_periodo,
                c.pasta_id AS coordenacao_pasta_id,
                p.nome AS coordenacao_pasta_nome,
                p.parent_id AS coordenacao_pasta_parent_id
            FROM jovens_comissoes jc 
            LEFT JOIN outros_ejcs oe ON jc.outro_ejc_id = oe.id AND oe.tenant_id = jc.tenant_id
            LEFT JOIN coordenacoes_membros cm ON cm.comissao_id = jc.id
            LEFT JOIN coordenacoes c ON c.id = cm.coordenacao_id
            LEFT JOIN coordenacoes_pastas p ON p.id = c.pasta_id
            WHERE jc.jovem_id = ? 
              AND jc.tenant_id = ?
            ORDER BY jc.id DESC
        `, [req.params.jovemId, tenantId]);

        const idsPasta = [...new Set(
            (rows || [])
                .map(r => Number(r.coordenacao_pasta_id))
                .filter(v => Number.isFinite(v) && v > 0)
        )];

        let pastasMap = new Map();
        if (idsPasta.length) {
            const [pastas] = await pool.query('SELECT id, nome, parent_id FROM coordenacoes_pastas');
            pastasMap = new Map((pastas || []).map(p => [Number(p.id), p]));
        }

        const montarCaminho = (pastaId) => {
            if (!pastaId || !pastasMap.size) return null;
            const nomes = [];
            const visitados = new Set();
            let atual = pastasMap.get(Number(pastaId));
            while (atual && !visitados.has(Number(atual.id))) {
                nomes.unshift(String(atual.nome || '').trim());
                visitados.add(Number(atual.id));
                const parentId = atual.parent_id ? Number(atual.parent_id) : null;
                atual = parentId ? pastasMap.get(parentId) : null;
            }
            return nomes.filter(Boolean).join(' / ') || null;
        };

        const normalizados = (rows || []).map(r => ({
            ...r,
            coordenacao_pasta_caminho: montarCaminho(r.coordenacao_pasta_id)
        }));

        res.json(normalizados);
    } catch (err) {
        console.error("Erro ao buscar comissões:", err);
        res.status(500).json({ error: "Erro ao buscar comissões" });
    }
});

// POST - Adicionar comissão
router.post('/comissoes', async (req, res) => {
    const { jovem_id, tipo, ejc_numero, paroquia, data_inicio, data_fim, funcao_garcom, semestre, circulo, observacao, outro_ejc_id } = req.body;

    if (!jovem_id || !tipo) {
        return res.status(400).json({ error: "Jovem e Tipo são obrigatórios" });
    }

    try {
        const tenantId = getTenantId(req);
        const [result] = await pool.query(
            `INSERT INTO jovens_comissoes (tenant_id, jovem_id, tipo, ejc_numero, paroquia, data_inicio, data_fim, funcao_garcom, semestre, circulo, observacao, outro_ejc_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [tenantId, jovem_id, tipo, ejc_numero || null, paroquia || null, data_inicio || null, data_fim || null, funcao_garcom || null, semestre || null, circulo || null, observacao || null, outro_ejc_id || null]
        );
        res.json({ id: result.insertId, message: "Histórico adicionado com sucesso" });
    } catch (err) {
        console.error("Erro ao adicionar comissão:", err);
        res.status(500).json({ error: "Erro ao salvar histórico" });
    }
});

// DELETE - Remover comissão
router.delete('/comissoes/:id', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const [[item]] = await pool.query(
            'SELECT id, tipo FROM jovens_comissoes WHERE id = ? AND tenant_id = ? LIMIT 1',
            [req.params.id, tenantId]
        );
        if (!item) return res.status(404).json({ error: "Item não encontrado" });
        if (item.tipo === 'COORDENACAO') {
            return res.status(403).json({ error: "Itens de coordenação devem ser gerenciados na tela Cordenadores." });
        }
        if (item.tipo === 'GARCOM_EQUIPE') {
            return res.status(403).json({ error: "Itens de equipe de garçom devem ser gerenciados na tela Garçons." });
        }

        await pool.query('DELETE FROM jovens_comissoes WHERE id = ? AND tenant_id = ?', [req.params.id, tenantId]);
        res.json({ message: "Histórico removido" });
    } catch (err) {
        console.error("Erro ao remover comissão:", err);
        res.status(500).json({ error: "Erro ao remover item" });
    }
});

// GET - Presenças de formulários de um jovem
router.get('/presencas/:jovemId', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const jovemId = Number(req.params.jovemId);
        if (!Number.isInteger(jovemId) || jovemId <= 0) {
            return res.status(400).json({ error: 'Jovem inválido.' });
        }

        const hasForms = await hasTable('formularios_itens');
        const hasPresencas = await hasTable('formularios_presencas');
        if (!hasForms || !hasPresencas) return res.json([]);
        const hasEventoData = await hasColumn('formularios_itens', 'evento_data');

        const [rows] = await pool.query(`
            SELECT
                fp.id,
                fp.formulario_id,
                fi.titulo AS evento_titulo,
                ${hasEventoData ? 'fi.evento_data' : 'NULL AS evento_data'},
                fp.registrado_em
            FROM formularios_presencas fp
            JOIN formularios_itens fi ON fi.id = fp.formulario_id AND fi.tenant_id = fp.tenant_id
            WHERE fp.jovem_id = ?
              AND fp.tenant_id = ?
            ORDER BY fp.registrado_em DESC
        `, [jovemId, tenantId]);

        return res.json(rows);
    } catch (err) {
        console.error('Erro ao buscar presenças do jovem:', err);
        return res.status(500).json({ error: 'Erro ao buscar presenças.' });
    }
});

// GET - Listar observações de um jovem
router.get('/observacoes/:jovemId', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const [rows] = await pool.query('SELECT * FROM jovens_observacoes WHERE jovem_id = ? AND tenant_id = ? ORDER BY created_at DESC', [req.params.jovemId, tenantId]);
        res.json(rows);
    } catch (err) {
        console.error("Erro ao buscar observacoes:", err);
        res.status(500).json({ error: "Erro ao buscar observações" });
    }
});

// POST - Adicionar observação
router.post('/observacoes', async (req, res) => {
    const { jovem_id, texto } = req.body;

    if (!jovem_id || !texto || !texto.trim()) {
        return res.status(400).json({ error: "Jovem e Texto são obrigatórios" });
    }

    try {
        const tenantId = getTenantId(req);
        const [result] = await pool.query(
            `INSERT INTO jovens_observacoes (tenant_id, jovem_id, texto) VALUES (?, ?, ?)`,
            [tenantId, jovem_id, texto.trim()]
        );
        res.json({ id: result.insertId, message: "Observação adicionada com sucesso" });
    } catch (err) {
        console.error("Erro ao adicionar observacao:", err);
        res.status(500).json({ error: "Erro ao salvar observação" });
    }
});

// DELETE - Remover observação específica (usado para retirar recusa, se necessário)
router.delete('/observacoes/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });
    try {
        const tenantId = getTenantId(req);
        const [obsRows] = await pool.query(
            'SELECT id, jovem_id, texto FROM jovens_observacoes WHERE id = ? AND tenant_id = ? LIMIT 1',
            [id, tenantId]
        );
        if (!obsRows.length) return res.status(404).json({ error: 'Observação não encontrada.' });
        const obs = obsRows[0];
        const texto = String(obs.texto || '').trim();
        const match = texto.match(/^Jovem recusou servir no\s+(\d+)\s*º?\s*encontro de montagem/i);
        if (match && obs.jovem_id) {
            const numero = Number(match[1]);
            if (Number.isFinite(numero)) {
                const [montagens] = await pool.query(
                    'SELECT id FROM montagens WHERE tenant_id = ? AND numero_ejc = ?',
                    [tenantId, numero]
                );
                for (const m of montagens || []) {
                    await pool.query(
                        'DELETE FROM montagem_membros WHERE montagem_id = ? AND jovem_id = ? AND tenant_id = ?',
                        [m.id, obs.jovem_id, tenantId]
                    );
                }
                const likeMontagem = `${numero}%EJC (Montagem)%`;
                await pool.query(
                    `DELETE FROM historico_equipes
                     WHERE jovem_id = ?
                       AND tenant_id = ?
                       AND (edicao_ejc LIKE ? OR edicao_ejc = ?)`,
                    [obs.jovem_id, tenantId, likeMontagem, `${numero}º EJC (Montagem)`]
                );
            }
        }

        const [result] = await pool.query('DELETE FROM jovens_observacoes WHERE id = ? AND tenant_id = ? LIMIT 1', [id, tenantId]);
        if (!result.affectedRows) return res.status(404).json({ error: 'Observação não encontrada.' });
        return res.json({ message: 'Observação removida com sucesso.' });
    } catch (err) {
        console.error('Erro ao remover observação:', err);
        return res.status(500).json({ error: 'Erro ao remover observação.' });
    }
});

// --- PASTORAIS (VÍNCULO COM JOVENS) ---

router.get('/:id/pastorais', async (req, res) => {
    try {
        await ensurePastoraisTables();
        const tenantId = getTenantId(req);
        const jovemId = Number(req.params.id);
        if (!jovemId) return res.status(400).json({ error: 'Jovem inválido.' });

        const [rows] = await pool.query(
            `SELECT p.id, p.nome
             FROM pastorais_jovens pj
             JOIN pastorais p ON p.id = pj.pastoral_id AND p.tenant_id = pj.tenant_id
             WHERE pj.tenant_id = ? AND pj.jovem_id = ?
             ORDER BY p.nome ASC`,
            [tenantId, jovemId]
        );
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar pastorais do jovem:', err);
        return res.status(500).json({ error: 'Erro ao listar pastorais.' });
    }
});

router.put('/:id/pastorais', async (req, res) => {
    try {
        await ensurePastoraisTables();
        const tenantId = getTenantId(req);
        const jovemId = Number(req.params.id);
        if (!jovemId) return res.status(400).json({ error: 'Jovem inválido.' });

        const pastorais = Array.isArray(req.body.pastorais) ? req.body.pastorais : [];
        const ids = pastorais
            .map((v) => Number(v))
            .filter((v) => Number.isFinite(v) && v > 0);

        // valida se jovem existe
        const [[jovem]] = await pool.query(
            'SELECT id FROM jovens WHERE id = ? AND tenant_id = ? LIMIT 1',
            [jovemId, tenantId]
        );
        if (!jovem) return res.status(404).json({ error: 'Jovem não encontrado.' });

        if (ids.length) {
            const [valid] = await pool.query(
                `SELECT id FROM pastorais WHERE tenant_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
                [tenantId, ...ids]
            );
            const validSet = new Set((valid || []).map((v) => Number(v.id)));
            const invalid = ids.filter((v) => !validSet.has(v));
            if (invalid.length) return res.status(400).json({ error: 'Pastoral inválida.' });
        }

        await pool.query(
            'DELETE FROM pastorais_jovens WHERE tenant_id = ? AND jovem_id = ?',
            [tenantId, jovemId]
        );

        if (ids.length) {
            const values = ids.map((id) => [tenantId, id, jovemId]);
            await pool.query(
                'INSERT INTO pastorais_jovens (tenant_id, pastoral_id, jovem_id) VALUES ?',
                [values]
            );
        }

        return res.json({ message: 'Pastorais atualizadas com sucesso.' });
    } catch (err) {
        console.error('Erro ao atualizar pastorais do jovem:', err);
        return res.status(500).json({ error: 'Erro ao atualizar pastorais.' });
    }
});

module.exports = router;
