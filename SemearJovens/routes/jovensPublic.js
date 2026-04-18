const express = require('express');
const { pool } = require('../database');
const crypto = require('crypto');
const { getTenantId } = require('../lib/tenantIsolation');
const { ensurePastoraisTables } = require('../lib/pastorais');

const router = express.Router();
const TOKEN_TTL_MS = 15 * 60 * 1000;
const TOKEN_SECRET = process.env.JOVENS_PUBLIC_TOKEN_SECRET || process.env.JWT_SECRET || 'semea-jovens-public';
let ensureTiosVinculosPromise = null;

function normalizeDate(v) {
    if (!v) return null;
    const txt = String(v).trim();
    if (!txt) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(txt)) return txt;
    const br = txt.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/);
    if (br) {
        const dia = Number(br[1]);
        const mes = Number(br[2]);
        const ano = Number(br[3]);
        if (dia && mes && ano) {
            return `${String(ano).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
        }
    }
    if (txt.includes('T')) return txt.split('T')[0];
    return null;
}

function normalizePhoneDigits(v) {
    return String(v || '').replace(/\D/g, '');
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

async function hasTable(tableName) {
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
    `, [tableName]);
    return !!(rows && rows[0] && rows[0].cnt > 0);
}

async function ensureAtualizacaoTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS jovens_atualizacao_comentarios (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NULL,
            jovem_id INT NULL,
            nome_completo VARCHAR(180) NULL,
            telefone VARCHAR(30) NULL,
            comentario TEXT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS jovens_atualizacao_nao_encontrado (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NULL,
            nome_completo VARCHAR(180) NOT NULL,
            telefone VARCHAR(30) NOT NULL,
            ejc_que_fez VARCHAR(180) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    if (!await hasColumn('jovens_atualizacao_comentarios', 'observacoes_adicionais')) {
        await pool.query('ALTER TABLE jovens_atualizacao_comentarios ADD COLUMN observacoes_adicionais TEXT NULL AFTER comentario');
    }
    if (!await hasColumn('jovens_atualizacao_nao_encontrado', 'observacoes_adicionais')) {
        await pool.query('ALTER TABLE jovens_atualizacao_nao_encontrado ADD COLUMN observacoes_adicionais TEXT NULL AFTER ejc_que_fez');
    }
    if (!await hasColumn('jovens_atualizacao_nao_encontrado', 'origem_formulario')) {
        await pool.query('ALTER TABLE jovens_atualizacao_nao_encontrado ADD COLUMN origem_formulario VARCHAR(120) NULL AFTER observacoes_adicionais');
    }
}

async function ensureJovensTermosColumns() {
    if (!await hasColumn('jovens', 'email')) {
        try {
            await pool.query('ALTER TABLE jovens ADD COLUMN email VARCHAR(180) NULL AFTER telefone');
        } catch (err) {
            if (!err || err.code !== 'ER_DUP_FIELDNAME') throw err;
        }
    }
    if (!await hasColumn('jovens', 'termos_aceitos_em')) {
        try {
            await pool.query('ALTER TABLE jovens ADD COLUMN termos_aceitos_em DATETIME NULL AFTER email');
        } catch (err) {
            if (!err || err.code !== 'ER_DUP_FIELDNAME') throw err;
        }
    }
    if (!await hasColumn('jovens', 'termos_aceitos_email')) {
        try {
            await pool.query('ALTER TABLE jovens ADD COLUMN termos_aceitos_email VARCHAR(180) NULL AFTER termos_aceitos_em');
        } catch (err) {
            if (!err || err.code !== 'ER_DUP_FIELDNAME') throw err;
        }
    }
}

async function ensureMontagemEjcColumn() {
    if (!await hasColumn('jovens', 'montagem_ejc_id')) {
        try {
            await pool.query('ALTER TABLE jovens ADD COLUMN montagem_ejc_id INT NULL AFTER numero_ejc_fez');
        } catch (err) {
            if (!err || err.code !== 'ER_DUP_FIELDNAME') throw err;
        }
    }
}

async function ensureApelidoColumn() {
    if (!await hasColumn('jovens', 'apelido')) {
        try {
            await pool.query('ALTER TABLE jovens ADD COLUMN apelido VARCHAR(120) NULL AFTER nome_completo');
        } catch (err) {
            if (!err || err.code !== 'ER_DUP_FIELDNAME') throw err;
        }
    }
}

async function ensureEquipeSaudeColumn() {
    if (!await hasColumn('jovens', 'equipe_saude')) {
        try {
            await pool.query('ALTER TABLE jovens ADD COLUMN equipe_saude TINYINT(1) NOT NULL DEFAULT 0 AFTER eh_musico');
        } catch (err) {
            if (!err || err.code !== 'ER_DUP_FIELDNAME') throw err;
        }
    }
}

async function ensureEnderecoColumns() {
    const columns = [
        ['endereco_rua', 'ALTER TABLE jovens ADD COLUMN endereco_rua VARCHAR(180) NULL'],
        ['endereco_numero', 'ALTER TABLE jovens ADD COLUMN endereco_numero VARCHAR(30) NULL'],
        ['endereco_bairro', 'ALTER TABLE jovens ADD COLUMN endereco_bairro VARCHAR(120) NULL'],
        ['endereco_cidade', 'ALTER TABLE jovens ADD COLUMN endereco_cidade VARCHAR(120) NULL'],
        ['endereco_cep', 'ALTER TABLE jovens ADD COLUMN endereco_cep VARCHAR(12) NULL']
    ];
    for (const [columnName, sql] of columns) {
        if (await hasColumn('jovens', columnName)) continue;
        try {
            await pool.query(sql);
        } catch (err) {
            if (!err || err.code !== 'ER_DUP_FIELDNAME') throw err;
        }
    }
}

async function ensureConjugeColumns() {
    const columns = [
        ['conjuge_nome', 'ALTER TABLE jovens ADD COLUMN conjuge_nome VARCHAR(180) NULL'],
        ['conjuge_telefone', 'ALTER TABLE jovens ADD COLUMN conjuge_telefone VARCHAR(30) NULL'],
        ['conjuge_outro_ejc_id', 'ALTER TABLE jovens ADD COLUMN conjuge_outro_ejc_id INT NULL'],
        ['conjuge_paroquia', 'ALTER TABLE jovens ADD COLUMN conjuge_paroquia VARCHAR(180) NULL'],
        ['conjuge_ecc_tipo', 'ALTER TABLE jovens ADD COLUMN conjuge_ecc_tipo VARCHAR(10) NULL'],
        ['conjuge_ecc_numero', 'ALTER TABLE jovens ADD COLUMN conjuge_ecc_numero VARCHAR(30) NULL'],
        ['observacoes_extras', 'ALTER TABLE jovens ADD COLUMN observacoes_extras TEXT NULL']
    ];
    for (const [columnName, sql] of columns) {
        if (await hasColumn('jovens', columnName)) continue;
        try {
            await pool.query(sql);
        } catch (err) {
            if (!err || err.code !== 'ER_DUP_FIELDNAME') throw err;
        }
    }
}

async function ensureTiosVinculos() {
    if (ensureTiosVinculosPromise) return ensureTiosVinculosPromise;
    ensureTiosVinculosPromise = (async () => {
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

async function ensureObservacoesTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS jovens_observacoes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            jovem_id INT NOT NULL,
            texto TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_jovens_observacoes_jovem (jovem_id),
            KEY idx_jovens_observacoes_tenant (tenant_id)
        )
    `);
}

function isTipoEccValido(tipo) {
    return tipo === 'ECC' || tipo === 'ECNA';
}

async function ensureTiosTablesPublic() {
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
}

async function findOrCreateTiosEcc({ tenantId, numero, tipo }) {
    const numeroTxt = String(numero || '').trim();
    const tipoTxt = String(tipo || '').trim().toUpperCase();
    if (!numeroTxt || !isTipoEccValido(tipoTxt)) return null;

    await ensureTiosTablesPublic();
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

async function resolveTenantIdPublico(req, montagemId = null) {
    const montagemNum = Number(montagemId || req.query.montagem_id || req.body.montagem_id || 0);
    if (Number.isInteger(montagemNum) && montagemNum > 0) {
        const [rows] = await pool.query(
            `SELECT tenant_id
             FROM montagens
             WHERE id = ?
             LIMIT 1`,
            [montagemNum]
        );
        const tenantMontagem = rows && rows[0] ? Number(rows[0].tenant_id) : 0;
        if (Number.isInteger(tenantMontagem) && tenantMontagem > 0) {
            return tenantMontagem;
        }
    }
    return getTenantId(req);
}

function serializarInstrumentos(value, ehMusico) {
    if (!ehMusico) return null;
    let lista = [];
    if (Array.isArray(value)) {
        lista = value.map((v) => String(v || '').trim()).filter(Boolean);
    } else {
        const txt = String(value || '').trim();
        if (txt) lista = txt.split(',').map((v) => v.trim()).filter(Boolean);
    }
    return lista.length ? JSON.stringify(lista) : null;
}

function criarTokenValidacao(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
    return `${body}.${sig}`;
}

function validarTokenValidacao(token) {
    try {
        if (!token || typeof token !== 'string' || !token.includes('.')) return null;
        const [body, sig] = token.split('.');
        const sigEsperada = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
        if (sig !== sigEsperada) return null;
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!payload || !payload.jovem_id || !payload.tenant_id || !payload.ts) return null;
        if ((Date.now() - Number(payload.ts)) > TOKEN_TTL_MS) return null;
        return payload;
    } catch (_) {
        return null;
    }
}

const ULTIMA_EQUIPE_NENHUMA = '__NENHUMA_EQUIPE__';

async function buscarJovemValidado({ nomeCompleto, telefone, dataNascimento, ultimaEquipe }) {
    const telefoneDigits = normalizePhoneDigits(telefone);
    if (!telefoneDigits) {
        return { error: 'Telefone inválido.', status: 400 };
    }

    const [rows] = await pool.query(
        `SELECT j.id, j.tenant_id, j.nome_completo
         FROM jovens j
         WHERE LOWER(TRIM(j.nome_completo)) = LOWER(TRIM(?))
           AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(COALESCE(j.telefone, '')), ' ', ''), '(', ''), ')', ''), '-', ''), '+', '') = ?
           AND DATE(j.data_nascimento) = ?`,
        [nomeCompleto, telefoneDigits, dataNascimento]
    );

    if (!rows.length) {
        return { error: 'Não encontramos cadastro com essas informações.', status: 404 };
    }
    if (rows.length > 1) {
        return { error: 'Encontramos mais de um cadastro. Procure a coordenação para atualização assistida.', status: 409 };
    }
    const jovem = rows[0];
    const [hist] = await pool.query(
        `SELECT he.equipe, he.edicao_ejc, he.created_at, he.id, he.ejc_id, e.numero AS ejc_numero
         FROM historico_equipes he
         LEFT JOIN ejc e ON e.id = he.ejc_id AND e.tenant_id = he.tenant_id
         WHERE he.jovem_id = ?
           AND he.tenant_id = ?
         ORDER BY he.id DESC`,
        [jovem.id, jovem.tenant_id]
    );

    const montagensAtivas = await hasTable('montagens')
        ? await pool.query(
            'SELECT numero_ejc FROM montagens WHERE tenant_id = ?',
            [jovem.tenant_id]
        )
        : [[]];
    const numerosMontagem = new Set(
        ((montagensAtivas && montagensAtivas[0]) || [])
            .map((item) => Number(item.numero_ejc || 0))
            .filter((numero) => Number.isFinite(numero) && numero > 0)
    );

    const semMontagem = (hist || []).filter((h) => {
        const ed = String(h?.edicao_ejc || '');
        if (ed && ed.includes('(Montagem)')) return false;
        const numeroDireto = Number(h?.ejc_numero || 0);
        if (Number.isFinite(numeroDireto) && numeroDireto > 0 && numerosMontagem.has(numeroDireto)) return false;
        if (ed) {
            const m = ed.match(/(\d+)/);
            const numeroTexto = m ? Number(m[1]) : null;
            if (Number.isFinite(numeroTexto) && numeroTexto > 0 && numerosMontagem.has(numeroTexto)) return false;
        }
        return !!(h && (h.ejc_id || ed));
    });

    const normalizados = semMontagem.map((h) => {
        const numero = h.ejc_numero ? Number(h.ejc_numero) : null;
        if (Number.isFinite(numero) && numero > 0) return { ...h, numero_ejc: numero };
        const texto = String(h.edicao_ejc || '').trim();
        const m = texto.match(/(\d+)/);
        const num = m ? Number(m[1]) : null;
        return Number.isFinite(num) && num > 0 ? { ...h, numero_ejc: num } : null;
    }).filter(Boolean);

    const ultimaEquipeNormalizada = String(ultimaEquipe || '').trim();
    if (!normalizados.length) {
        if (ultimaEquipeNormalizada === ULTIMA_EQUIPE_NENHUMA) {
            return { jovem };
        }
        return { error: 'Não foi possível identificar a última equipe servida. Se você nunca serviu, selecione "Não servi em nenhuma equipe".', status: 404 };
    }

    if (ultimaEquipeNormalizada === ULTIMA_EQUIPE_NENHUMA) {
        return { error: 'Seu cadastro já possui equipe registrada em EJC finalizado. Selecione a última equipe em que você serviu.', status: 400 };
    }

    const maxNumero = Math.max(...normalizados.map((h) => h.numero_ejc));
    const candidatos = normalizados.filter((h) => h.numero_ejc === maxNumero);
    candidatos.sort((a, b) => {
        const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
        const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
        if (aTime !== bTime) return bTime - aTime;
        return (b.id || 0) - (a.id || 0);
    });
    const ultimo = candidatos[0];
    const ultimaEquipeRegistrada = String(ultimo?.equipe || '').trim().toLowerCase();
    if (ultimaEquipeRegistrada !== ultimaEquipeNormalizada.toLowerCase()) {
        return { error: 'Última equipe informada não confere com o último EJC servido.', status: 400 };
    }

    return { jovem };
}

router.get('/equipes', async (_req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT DISTINCT nome FROM equipes WHERE TRIM(COALESCE(nome, "")) <> "" ORDER BY nome ASC'
        );
        return res.json((rows || []).map((r) => r.nome).filter(Boolean));
    } catch (err) {
        console.error('Erro ao listar equipes públicas para atualização de jovens:', err);
        return res.status(500).json({ error: 'Erro ao listar equipes.' });
    }
});

router.get('/pastorais', async (req, res) => {
    try {
        const { ensurePastoraisTables } = require('../lib/pastorais');
        const token = String(req.query.token || '').trim();
        const tokenPayload = validarTokenValidacao(token);
        if (!tokenPayload) {
            return res.status(401).json({ error: 'Validação expirada ou inválida.' });
        }
        await ensurePastoraisTables();
        const [rows] = await pool.query(
            'SELECT id, nome FROM pastorais WHERE tenant_id = ? ORDER BY nome ASC',
            [tokenPayload.tenant_id]
        );
        return res.json(rows || []);
    } catch (err) {
        console.error('Erro ao listar pastorais públicas:', err);
        return res.status(500).json({ error: 'Erro ao listar pastorais.' });
    }
});

router.get('/tios', async (req, res) => {
    try {
        const token = String(req.query.token || '').trim();
        const tokenPayload = validarTokenValidacao(token);
        if (!tokenPayload) {
            return res.status(401).json({ error: 'Validação expirada ou inválida.' });
        }
        await ensureTiosTablesPublic();
        const [rows] = await pool.query(
            `SELECT id, nome_tio, nome_tia
             FROM tios_casais
             WHERE tenant_id = ?
             ORDER BY nome_tio ASC, nome_tia ASC`,
            [tokenPayload.tenant_id]
        );
        return res.json(rows || []);
    } catch (err) {
        console.error('Erro ao listar tios públicos:', err);
        return res.status(500).json({ error: 'Erro ao listar tios.' });
    }
});

router.get('/me', async (req, res) => {
    try {
        const token = String(req.query.token || '').trim();
        const tokenPayload = validarTokenValidacao(token);
        if (!tokenPayload) {
            return res.status(401).json({ error: 'Validação expirada ou inválida.' });
        }

        await Promise.all([
            ensurePastoraisTables(),
            ensureTiosVinculos(),
            ensureApelidoColumn(),
            ensureEquipeSaudeColumn(),
            ensureEnderecoColumns(),
            ensureJovensTermosColumns()
        ]);

        const [jovemRows] = await pool.query(
            `SELECT id, tenant_id, nome_completo, apelido, telefone, email, instagram, estado_civil,
                    data_nascimento, endereco_cep, endereco_rua, endereco_numero, endereco_bairro, endereco_cidade,
                    deficiencia, qual_deficiencia, restricao_alimentar, detalhes_restricao,
                    eh_musico, instrumentos_musicais, equipe_saude
             FROM jovens
             WHERE id = ? AND tenant_id = ?
             LIMIT 1`,
            [tokenPayload.jovem_id, tokenPayload.tenant_id]
        );
        if (!jovemRows.length) {
            return res.status(404).json({ error: 'Cadastro não encontrado.' });
        }

        const jovem = jovemRows[0];
        const [pastoraisRows] = await pool.query(
            `SELECT pastoral_id
             FROM pastorais_jovens
             WHERE tenant_id = ? AND jovem_id = ?`,
            [tokenPayload.tenant_id, tokenPayload.jovem_id]
        );
        const [[tiosRow]] = await pool.query(
            `SELECT casal_id
             FROM tios_jovens
             WHERE tenant_id = ? AND jovem_id = ?
             LIMIT 1`,
            [tokenPayload.tenant_id, tokenPayload.jovem_id]
        );

        let instrumentos = [];
        try {
            instrumentos = jovem.instrumentos_musicais ? JSON.parse(jovem.instrumentos_musicais) : [];
        } catch (_) {
            instrumentos = [];
        }

        return res.json({
            jovem: {
                ...jovem,
                deficiencia: Number(jovem.deficiencia || 0) === 1,
                restricao_alimentar: Number(jovem.restricao_alimentar || 0) === 1,
                eh_musico: Number(jovem.eh_musico || 0) === 1,
                equipe_saude: Number(jovem.equipe_saude || 0) === 1,
                instrumentos_musicais: Array.isArray(instrumentos) ? instrumentos : [],
                pastorais: (pastoraisRows || []).map((row) => Number(row.pastoral_id)).filter(Boolean),
                tio_casal_id: Number((tiosRow || {}).casal_id || 0) || ''
            }
        });
    } catch (err) {
        console.error('Erro ao carregar dados públicos do jovem:', err);
        return res.status(500).json({ error: 'Erro ao carregar dados do cadastro.' });
    }
});

router.get('/ejcs-outros', async (_req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT id, tenant_id, nome, paroquia, bairro FROM outros_ejcs ORDER BY nome ASC'
        );
        return res.json(rows || []);
    } catch (err) {
        console.error('Erro ao listar outros EJCs (público):', err);
        return res.status(500).json({ error: 'Erro ao listar EJCs.' });
    }
});

router.get('/cadastro-opcoes', async (req, res) => {
    try {
        const tenantId = await resolveTenantIdPublico(req);
        await ensurePastoraisTables();

        const [[hasMontagensTable], ejcsRows, circulosRows, pastoraisRows, tiosRows, outrosEjcsRows] = await Promise.all([
            pool.query(
                `SELECT COUNT(*) AS cnt
                 FROM information_schema.TABLES
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = 'montagens'`
            ),
            pool.query('SELECT id, numero, descricao, data_inicio FROM ejc WHERE tenant_id = ? ORDER BY numero DESC', [tenantId]),
            hasColumn('circulos', 'tenant_id')
                ? pool.query('SELECT id, nome, cor_hex FROM circulos WHERE ativo = 1 AND tenant_id = ? ORDER BY ordem ASC, nome ASC', [tenantId])
                : Promise.resolve([[]]),
            pool.query('SELECT id, nome FROM pastorais WHERE tenant_id = ? ORDER BY nome ASC', [tenantId]),
            hasColumn('tios_casais', 'tenant_id')
                ? pool.query('SELECT id, nome_tio, nome_tia FROM tios_casais WHERE tenant_id = ? ORDER BY nome_tio ASC, nome_tia ASC', [tenantId])
                : Promise.resolve([[]]),
            pool.query('SELECT id, nome, paroquia FROM outros_ejcs ORDER BY nome ASC')
        ]);

        const ejcs = Array.isArray(ejcsRows[0]) ? ejcsRows[0].map((item) => ({ ...item, em_montagem: false })) : [];
        const porNumero = new Map(ejcs.map((item) => [Number(item.numero), item]));
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
                ejcs.push({
                    id: `montagem:${montagem.id}`,
                    numero,
                    descricao: null,
                    data_inicio: montagem.data_inicio || null,
                    data_fim: montagem.data_fim || null,
                    data_encontro: montagem.data_encontro || null,
                    em_montagem: true,
                    montagem_id: montagem.id
                });
            }
        }
        ejcs.sort((a, b) => Number(b.numero || 0) - Number(a.numero || 0));

        return res.json({
            ejcs,
            circulos: circulosRows[0] || [],
            pastorais: pastoraisRows[0] || [],
            tios_casais: tiosRows[0] || [],
            outros_ejcs: outrosEjcsRows[0] || []
        });
    } catch (err) {
        console.error('Erro ao listar opções do cadastro público de jovens:', err);
        return res.status(500).json({ error: 'Erro ao carregar opções do formulário.' });
    }
});

router.post('/validar-cadastro', async (req, res) => {
    try {
        const nomeCompleto = String(req.body.nome_completo || '').trim();
        const telefone = String(req.body.telefone || '').trim();
        const dataNascimento = normalizeDate(req.body.data_nascimento);
        const ultimaEquipe = String(req.body.ultima_equipe || '').trim();

        if (!nomeCompleto || !telefone || !dataNascimento || !ultimaEquipe) {
            return res.status(400).json({ error: 'Preencha nome, telefone, data de nascimento e última equipe.' });
        }

        const resultado = await buscarJovemValidado({ nomeCompleto, telefone, dataNascimento, ultimaEquipe });
        if (resultado.error) return res.status(resultado.status).json({ error: resultado.error });

        const token = criarTokenValidacao({
            jovem_id: resultado.jovem.id,
            tenant_id: resultado.jovem.tenant_id,
            ts: Date.now()
        });

        return res.json({
            message: 'Cadastro confirmado. Agora você pode atualizar seus dados.',
            token
        });
    } catch (err) {
        console.error('Erro ao validar cadastro no formulário público de jovens:', err);
        return res.status(500).json({ error: 'Erro ao validar cadastro.' });
    }
});

router.post('/atualizar', async (req, res) => {
    try {
        const token = String(req.body.validacao_token || '').trim();
        const tokenPayload = validarTokenValidacao(token);
        if (!tokenPayload) {
            return res.status(401).json({ error: 'Validação expirada ou inválida. Confirme seus dados novamente.' });
        }

        const [jovemRows] = await pool.query(
            'SELECT id, tenant_id, nome_completo, telefone FROM jovens WHERE id = ? AND tenant_id = ? LIMIT 1',
            [tokenPayload.jovem_id, tokenPayload.tenant_id]
        );
        if (!jovemRows.length) {
            return res.status(404).json({ error: 'Cadastro não encontrado.' });
        }

        const jovem = jovemRows[0];
        const nomeCompletoNovo = String(req.body.nome_completo_novo || '').trim() || null;
        const telefoneNovo = String(req.body.telefone_novo || '').trim() || String(jovem.telefone || '').trim();
        const email = String(req.body.email || '').trim() || null;
        const instagram = String(req.body.instagram || '').trim() || null;
        const estadoCivil = String(req.body.estado_civil || '').trim() || null;
        const dataNascimentoNovo = normalizeDate(req.body.data_nascimento_novo || req.body.data_nascimento);
        const enderecoCep = String(req.body.endereco_cep || '').trim() || null;
        const enderecoRua = String(req.body.endereco_rua || '').trim() || null;
        const enderecoNumero = String(req.body.endereco_numero || '').trim() || null;
        const enderecoBairro = String(req.body.endereco_bairro || '').trim() || null;
        const enderecoCidade = String(req.body.endereco_cidade || '').trim() || null;
        const deficiencia = !!req.body.deficiencia;
        const qualDeficiencia = deficiencia ? (String(req.body.qual_deficiencia || '').trim() || null) : null;
        const restricaoAlimentar = !!req.body.restricao_alimentar;
        const detalhesRestricao = restricaoAlimentar ? (String(req.body.detalhes_restricao || '').trim() || null) : null;
        const ehMusico = !!req.body.eh_musico;
        const instrumentos = serializarInstrumentos(req.body.instrumentos_musicais, ehMusico);
        const pastorais = Array.isArray(req.body.pastorais) ? req.body.pastorais : [];
        const pastoraisIds = pastorais.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0);
        const comentarioAdicional = String(req.body.comentario_adicional || req.body.observacoes_adicionais || '').trim() || null;
        const aceiteTermos = req.body.aceite_termos === true || req.body.aceite_termos === 'true' || req.body.aceite_termos === 1 || req.body.aceite_termos === '1';

        if (!aceiteTermos) {
            return res.status(400).json({ error: 'É necessário aceitar os termos de uso.' });
        }

        await ensureJovensTermosColumns();
        await ensureApelidoColumn();
        await ensureEquipeSaudeColumn();
        await ensureTiosVinculos();

        const campos = [
            'telefone = ?',
            'estado_civil = ?',
            'deficiencia = ?',
            'qual_deficiencia = ?',
            'restricao_alimentar = ?',
            'detalhes_restricao = ?'
        ];
        const params = [
            telefoneNovo,
            estadoCivil,
            deficiencia ? 1 : 0,
            qualDeficiencia,
            restricaoAlimentar ? 1 : 0,
            detalhesRestricao
        ];
        const apelido = String(req.body.apelido || '').trim() || null;
        const equipeSaude = req.body.equipe_saude === true || req.body.equipe_saude === 'true' || req.body.equipe_saude === 1 || req.body.equipe_saude === '1';
        const tioCasalId = Number(req.body.tio_casal_id || 0) || null;

        if (nomeCompletoNovo && await hasColumn('jovens', 'nome_completo')) {
            campos.push('nome_completo = ?');
            params.push(nomeCompletoNovo);
        }
        if (await hasColumn('jovens', 'apelido')) {
            campos.push('apelido = ?');
            params.push(apelido);
        }
        if (email !== null && await hasColumn('jovens', 'email')) {
            campos.push('email = ?');
            params.push(email);
        }
        if (dataNascimentoNovo && await hasColumn('jovens', 'data_nascimento')) {
            campos.push('data_nascimento = ?');
            params.push(dataNascimentoNovo);
        }
        if (instagram !== null && await hasColumn('jovens', 'instagram')) {
            campos.push('instagram = ?');
            params.push(instagram);
        }
        if (await hasColumn('jovens', 'endereco_cep')) {
            campos.push('endereco_cep = ?');
            params.push(enderecoCep);
        }
        if (await hasColumn('jovens', 'endereco_rua')) {
            campos.push('endereco_rua = ?');
            params.push(enderecoRua);
        }
        if (await hasColumn('jovens', 'endereco_numero')) {
            campos.push('endereco_numero = ?');
            params.push(enderecoNumero);
        }
        if (await hasColumn('jovens', 'endereco_bairro')) {
            campos.push('endereco_bairro = ?');
            params.push(enderecoBairro);
        }
        if (await hasColumn('jovens', 'endereco_cidade')) {
            campos.push('endereco_cidade = ?');
            params.push(enderecoCidade);
        }
        if (await hasColumn('jovens', 'eh_musico')) {
            campos.push('eh_musico = ?');
            params.push(ehMusico ? 1 : 0);
        }
        if (await hasColumn('jovens', 'instrumentos_musicais')) {
            campos.push('instrumentos_musicais = ?');
            params.push(instrumentos);
        }
        if (await hasColumn('jovens', 'equipe_saude')) {
            campos.push('equipe_saude = ?');
            params.push(equipeSaude ? 1 : 0);
        }
        if (await hasColumn('jovens', 'termos_aceitos_em')) {
            campos.push('termos_aceitos_em = CURRENT_TIMESTAMP');
        }
        if (await hasColumn('jovens', 'termos_aceitos_email')) {
            campos.push('termos_aceitos_email = ?');
            params.push(email);
        }

        params.push(jovem.id, jovem.tenant_id);
        await pool.query(
            `UPDATE jovens SET ${campos.join(', ')} WHERE id = ? AND tenant_id = ?`,
            params
        );

        if (pastoraisIds.length || Array.isArray(req.body.pastorais)) {
            const { ensurePastoraisTables } = require('../lib/pastorais');
            await ensurePastoraisTables();
            if (pastoraisIds.length) {
                const [validas] = await pool.query(
                    `SELECT id FROM pastorais WHERE tenant_id = ? AND id IN (${pastoraisIds.map(() => '?').join(',')})`,
                    [jovem.tenant_id, ...pastoraisIds]
                );
                const validSet = new Set((validas || []).map((v) => Number(v.id)));
                const invalidas = pastoraisIds.filter((v) => !validSet.has(v));
                if (invalidas.length) {
                    return res.status(400).json({ error: 'Pastoral inválida.' });
                }
            }

            await pool.query(
                'DELETE FROM pastorais_jovens WHERE tenant_id = ? AND jovem_id = ?',
                [jovem.tenant_id, jovem.id]
            );

            if (pastoraisIds.length) {
                const values = pastoraisIds.map((id) => [jovem.tenant_id, id, jovem.id]);
                await pool.query(
                    'INSERT INTO pastorais_jovens (tenant_id, pastoral_id, jovem_id) VALUES ?',
                    [values]
                );
            }
        }

        if (req.body.tio_casal_id !== undefined) {
            if (tioCasalId) {
                const [casalRows] = await pool.query(
                    'SELECT id FROM tios_casais WHERE id = ? AND tenant_id = ? LIMIT 1',
                    [tioCasalId, jovem.tenant_id]
                );
                if (!casalRows.length) {
                    return res.status(400).json({ error: 'Casal de tios inválido.' });
                }
                await pool.query(
                    `INSERT INTO tios_jovens (tenant_id, casal_id, jovem_id)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE casal_id = VALUES(casal_id)`,
                    [jovem.tenant_id, tioCasalId, jovem.id]
                );
            } else {
                await pool.query(
                    'DELETE FROM tios_jovens WHERE tenant_id = ? AND jovem_id = ?',
                    [jovem.tenant_id, jovem.id]
                );
            }
        }

        if (comentarioAdicional) {
            await ensureAtualizacaoTables();
            await pool.query(
                `INSERT INTO jovens_atualizacao_comentarios (tenant_id, jovem_id, nome_completo, telefone, comentario, observacoes_adicionais)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [jovem.tenant_id, jovem.id, nomeCompletoNovo || jovem.nome_completo, telefoneNovo, comentarioAdicional, comentarioAdicional]
            );
        }

        return res.json({ message: 'Dados atualizados com sucesso.' });
    } catch (err) {
        console.error('Erro ao atualizar dados pelo formulário público de jovens:', err);
        return res.status(500).json({ error: 'Erro ao atualizar dados.' });
    }
});

router.post('/nao-encontrado', async (req, res) => {
    try {
        await ensureAtualizacaoTables();
        const nome = String(req.body.nome_completo || '').trim();
        const telefone = String(req.body.telefone || '').trim();
        const ejc = String(req.body.ejc_que_fez || '').trim();
        const observacoesAdicionais = String(req.body.observacoes_adicionais || '').trim() || null;
        const origemFormulario = String(req.body.origem_formulario || '').trim() || null;
        const tenantIdBody = req.body.tenant_id ? Number(req.body.tenant_id) : null;
        const tenantId = Number.isInteger(tenantIdBody) && tenantIdBody > 0
            ? tenantIdBody
            : getTenantId(req);
        if (!nome || !telefone || !ejc) {
            return res.status(400).json({ error: 'Informe nome, telefone e EJC que fez.' });
        }
        await pool.query(
            `INSERT INTO jovens_atualizacao_nao_encontrado (tenant_id, nome_completo, telefone, ejc_que_fez, observacoes_adicionais, origem_formulario)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [tenantId, nome, telefone, ejc, observacoesAdicionais, origemFormulario]
        );
        return res.json({ message: 'Dados enviados com sucesso.' });
    } catch (err) {
        console.error('Erro ao salvar não encontrado:', err);
        return res.status(500).json({ error: 'Erro ao enviar dados.' });
    }
});

router.post('/criar-cadastro', async (req, res) => {
    try {
        const nomeCompleto = String(req.body.nome_completo || '').trim();
        const apelido = String(req.body.apelido || '').trim() || null;
        const telefone = String(req.body.telefone || '').trim();
        const email = String(req.body.email || '').trim() || null;
        const instagram = String(req.body.instagram || '').trim() || null;
        const dataNascimento = normalizeDate(req.body.data_nascimento);
        const numeroEjcFezBruto = String(req.body.numero_ejc_fez || '').trim();
        let numeroEjcFez = null;
        let montagemEjcId = null;
        if (numeroEjcFezBruto.startsWith('montagem:')) {
            const montagemId = Number(numeroEjcFezBruto.split(':')[1] || 0);
            if (Number.isInteger(montagemId) && montagemId > 0) montagemEjcId = montagemId;
        } else if (numeroEjcFezBruto) {
            const parsed = Number(numeroEjcFezBruto);
            numeroEjcFez = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
        }
        const tenantId = await resolveTenantIdPublico(req, montagemEjcId);
        const sexo = ['Feminino', 'Masculino'].includes(String(req.body.sexo || '').trim()) ? String(req.body.sexo || '').trim() : null;
        const estadoCivil = ['Solteiro', 'Casado', 'Amasiado'].includes(String(req.body.estado_civil || '').trim())
            ? String(req.body.estado_civil || '').trim()
            : 'Solteiro';
        const dataCasamento = ['Casado', 'Amasiado'].includes(estadoCivil) ? normalizeDate(req.body.data_casamento) : null;
        const circulo = String(req.body.circulo || '').trim() || null;
        const enderecoCep = String(req.body.endereco_cep || '').trim() || null;
        const enderecoRua = String(req.body.endereco_rua || '').trim() || null;
        const enderecoNumero = String(req.body.endereco_numero || '').trim() || null;
        const enderecoBairro = String(req.body.endereco_bairro || '').trim() || null;
        const enderecoCidade = String(req.body.endereco_cidade || '').trim() || null;
        const deficiencia = !!req.body.deficiencia;
        const qualDeficiencia = deficiencia ? (String(req.body.qual_deficiencia || '').trim() || null) : null;
        const restricaoAlimentar = !!req.body.restricao_alimentar;
        const detalhesRestricao = restricaoAlimentar ? (String(req.body.detalhes_restricao || '').trim() || null) : null;
        const ehMusico = !!req.body.eh_musico;
        const instrumentos = serializarInstrumentos(req.body.instrumentos_musicais, ehMusico);
        const tioCasalId = Number(req.body.tio_casal_id || 0) || null;
        const conjugeNome = ['Casado', 'Amasiado'].includes(estadoCivil) ? (String(req.body.conjuge_nome || '').trim() || null) : null;
        const conjugeTelefone = ['Casado', 'Amasiado'].includes(estadoCivil) ? (String(req.body.conjuge_telefone || '').trim() || null) : null;
        const conjugeOutroEjcId = ['Casado', 'Amasiado'].includes(estadoCivil) ? (Number(req.body.conjuge_outro_ejc_id || 0) || null) : null;
        const conjugeParoquia = ['Casado', 'Amasiado'].includes(estadoCivil) ? (String(req.body.conjuge_paroquia || '').trim() || null) : null;
        const conjugeEccTipo = ['Casado', 'Amasiado'].includes(estadoCivil) ? (String(req.body.conjuge_ecc_tipo || '').trim() || null) : null;
        const conjugeEccNumero = ['Casado', 'Amasiado'].includes(estadoCivil) ? (String(req.body.conjuge_ecc_numero || '').trim() || null) : null;
        const observacoesExtras = String(req.body.observacoes_extras || req.body.observacoes_adicionais || '').trim() || null;
        const aceiteTermos = req.body.aceite_termos === true || req.body.aceite_termos === 'true' || req.body.aceite_termos === 1 || req.body.aceite_termos === '1';
        const moverCasalParaTios = req.body.mover_casal_para_tios === true
            || req.body.mover_casal_para_tios === 'true'
            || req.body.mover_casal_para_tios === 1
            || req.body.mover_casal_para_tios === '1';
        const pastoraisIds = (Array.isArray(req.body.pastorais) ? req.body.pastorais : [])
            .map((v) => Number(v))
            .filter((v) => Number.isFinite(v) && v > 0);

        if (!nomeCompleto || !telefone) {
            return res.status(400).json({ error: 'Preencha pelo menos nome completo e telefone.' });
        }
        if (!aceiteTermos) {
            return res.status(400).json({ error: 'É necessário aceitar os termos de uso.' });
        }
        if (deficiencia && !qualDeficiencia) {
            return res.status(400).json({ error: 'Informe a deficiência.' });
        }
        if (restricaoAlimentar && !detalhesRestricao) {
            return res.status(400).json({ error: 'Informe a restrição alimentar.' });
        }

        await ensureJovensTermosColumns();
        await ensureMontagemEjcColumn();
        await ensureApelidoColumn();
        await ensureEnderecoColumns();
        await ensureConjugeColumns();
        await ensurePastoraisTables();
        await ensureObservacoesTable();
        await ensureTiosVinculos();

        const campos = [
            'tenant_id',
            'nome_completo',
            'apelido',
            'telefone',
            'email',
            'termos_aceitos_em',
            'termos_aceitos_email',
            'data_nascimento',
            'numero_ejc_fez',
            'montagem_ejc_id',
            'instagram',
            'estado_civil',
            'data_casamento',
            'circulo',
            'deficiencia',
            'qual_deficiencia',
            'restricao_alimentar',
            'detalhes_restricao',
            'endereco_rua',
            'endereco_numero',
            'endereco_bairro',
            'endereco_cidade',
            'endereco_cep',
            'conjuge_nome',
            'conjuge_telefone',
            'conjuge_outro_ejc_id',
            'conjuge_paroquia',
            'conjuge_ecc_tipo',
            'conjuge_ecc_numero',
            'observacoes_extras'
        ];
        const valores = [
            tenantId,
            nomeCompleto,
            apelido,
            telefone,
            email,
            new Date(),
            email,
            dataNascimento,
            numeroEjcFez,
            montagemEjcId,
            instagram,
            estadoCivil,
            dataCasamento,
            circulo,
            deficiencia ? 1 : 0,
            qualDeficiencia,
            restricaoAlimentar ? 1 : 0,
            detalhesRestricao,
            enderecoRua,
            enderecoNumero,
            enderecoBairro,
            enderecoCidade,
            enderecoCep,
            conjugeNome,
            conjugeTelefone,
            conjugeOutroEjcId,
            conjugeParoquia,
            conjugeEccTipo,
            conjugeEccNumero,
            observacoesExtras
        ];

        if (await hasColumn('jovens', 'sexo')) {
            campos.push('sexo');
            valores.push(sexo);
        }
        if (await hasColumn('jovens', 'eh_musico')) {
            campos.push('eh_musico');
            valores.push(ehMusico ? 1 : 0);
        }
        if (await hasColumn('jovens', 'instrumentos_musicais')) {
            campos.push('instrumentos_musicais');
            valores.push(instrumentos);
        }

        const placeholders = campos.map(() => '?').join(', ');
        const [result] = await pool.query(
            `INSERT INTO jovens (${campos.join(', ')}) VALUES (${placeholders})`,
            valores
        );
        const jovemId = Number(result.insertId);

        if (tioCasalId) {
            const [casalRows] = await pool.query(
                'SELECT id FROM tios_casais WHERE id = ? AND tenant_id = ? LIMIT 1',
                [tioCasalId, tenantId]
            );
            if (casalRows.length) {
                await pool.query(
                    'INSERT INTO tios_jovens (tenant_id, casal_id, jovem_id) VALUES (?, ?, ?)',
                    [tenantId, tioCasalId, jovemId]
                );
            }
        }

        if (pastoraisIds.length) {
            const [validRows] = await pool.query(
                `SELECT id FROM pastorais WHERE tenant_id = ? AND id IN (${pastoraisIds.map(() => '?').join(',')})`,
                [tenantId, ...pastoraisIds]
            );
            const validIds = (validRows || []).map((row) => Number(row.id)).filter(Boolean);
            if (validIds.length) {
                await pool.query(
                    'INSERT INTO pastorais_jovens (tenant_id, pastoral_id, jovem_id) VALUES ?',
                    [validIds.map((id) => [tenantId, id, jovemId])]
                );
            }
        }

        if (observacoesExtras) {
            await pool.query(
                'INSERT INTO jovens_observacoes (tenant_id, jovem_id, texto) VALUES (?, ?, ?)',
                [tenantId, jovemId, observacoesExtras]
            );
        }

        if (moverCasalParaTios && isTipoEccValido(conjugeEccTipo) && conjugeEccNumero && conjugeNome) {
            try {
                await upsertCasalParaTios({
                    tenantId,
                    eccNumero: conjugeEccNumero,
                    eccTipo: conjugeEccTipo,
                    principal: {
                        nome_completo: nomeCompleto,
                        telefone,
                        data_nascimento: dataNascimento,
                        sexo
                    },
                    conjuge: {
                        nome_completo: conjugeNome,
                        telefone: conjugeTelefone,
                        data_nascimento: null,
                        sexo: null
                    }
                });
            } catch (e) {
                console.error('Erro ao mover casal para tios no cadastro público:', e);
            }
        }

        return res.status(201).json({ id: jovemId, message: 'Jovem criado com sucesso.' });
    } catch (err) {
        console.error('Erro ao criar cadastro público de jovem:', err);
        return res.status(500).json({ error: 'Erro ao criar cadastro.' });
    }
});

module.exports = router;
