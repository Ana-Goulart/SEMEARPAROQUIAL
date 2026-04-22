const express = require('express');
const { pool } = require('../database');
const { getTenantId } = require('../lib/tenantIsolation');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const uploadDirAbs = path.join(__dirname, '..', 'public', 'uploads', 'fotos_tios');

const storage = multer.diskStorage({
    destination: function (_req, _file, cb) {
        if (!fs.existsSync(uploadDirAbs)) {
            fs.mkdirSync(uploadDirAbs, { recursive: true });
        }
        cb(null, uploadDirAbs);
    },
    filename: function (_req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_'));
    }
});
const upload = multer({ storage });

let ensured = false;
let ensurePromise = null;
let ensureListaMestreAtivoPromise = null;
const NORMALIZED_PHONE_SQL = "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(COALESCE(%FIELD%, '')), ' ', ''), '(', ''), ')', ''), '-', ''), '+', '')";

async function ensureTiosServicosSnapshots() {
    const colunas = [
        ['nome_tio_snapshot', 'VARCHAR(180) NULL'],
        ['telefone_tio_snapshot', 'VARCHAR(30) NULL'],
        ['nome_tia_snapshot', 'VARCHAR(180) NULL'],
        ['telefone_tia_snapshot', 'VARCHAR(30) NULL']
    ];

    for (const [nome, definicao] of colunas) {
        if (await hasColumn('tios_casal_servicos', nome)) continue;
        await pool.query(`ALTER TABLE tios_casal_servicos ADD COLUMN ${nome} ${definicao}`);
    }

    await pool.query(`
        UPDATE tios_casal_servicos ts
        JOIN tios_casais tc
          ON tc.id = ts.casal_id
         AND tc.tenant_id = ts.tenant_id
        SET ts.nome_tio_snapshot = COALESCE(ts.nome_tio_snapshot, tc.nome_tio),
            ts.telefone_tio_snapshot = COALESCE(ts.telefone_tio_snapshot, tc.telefone_tio),
            ts.nome_tia_snapshot = COALESCE(ts.nome_tia_snapshot, tc.nome_tia),
            ts.telefone_tia_snapshot = COALESCE(ts.telefone_tia_snapshot, tc.telefone_tia)
        WHERE ts.nome_tio_snapshot IS NULL
           OR ts.nome_tia_snapshot IS NULL
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS tios_casal_servicos_historico (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            casal_id INT NULL,
            equipe_id INT NOT NULL,
            ejc_id INT NULL,
            nome_tio_snapshot VARCHAR(180) NULL,
            telefone_tio_snapshot VARCHAR(30) NULL,
            nome_tia_snapshot VARCHAR(180) NULL,
            telefone_tia_snapshot VARCHAR(30) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_tios_serv_hist_tenant_ejc (tenant_id, ejc_id),
            KEY idx_tios_serv_hist_equipe (tenant_id, equipe_id),
            KEY idx_tios_serv_hist_casal (tenant_id, casal_id)
        )
    `);
}

function montarNomeCasal(nomeTio, nomeTia) {
    return [String(nomeTio || '').trim(), String(nomeTia || '').trim()].filter(Boolean).join(' e ').trim();
}

function montarTelefoneCasalExterno(telefoneTio, telefoneTia) {
    return [String(telefoneTio || '').trim(), String(telefoneTia || '').trim()].filter(Boolean).join(' / ') || null;
}

function normalizarTextoComparacao(valor) {
    return String(valor || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function escolherFuncaoTio(funcoes) {
    const lista = Array.isArray(funcoes) ? funcoes.filter(Boolean) : [];
    if (!lista.length) return null;

    const porNomeExato = lista.find((item) => ['tio', 'tios'].includes(normalizarTextoComparacao(item.nome)));
    if (porNomeExato) return porNomeExato;

    const porPapelENome = lista.find((item) => normalizarTextoComparacao(item.papel_base) === 'tio' && /tio|tia/.test(normalizarTextoComparacao(item.nome)));
    if (porPapelENome) return porPapelENome;

    const porPapel = lista.find((item) => normalizarTextoComparacao(item.papel_base) === 'tio');
    if (porPapel) return porPapel;

    const porNome = lista.find((item) => /tio|tia/.test(normalizarTextoComparacao(item.nome)));
    return porNome || null;
}

async function sincronizarServicosCasalComMontagem({
    tenantId,
    casalId,
    nomeTio,
    telefoneTio,
    nomeTia,
    telefoneTia,
    aliasesNomes = []
}) {
    if (!casalId || !(await hasTable('montagem_membros')) || !(await hasTable('equipes_funcoes'))) {
        return;
    }

    const nomeCasalAtual = montarNomeCasal(nomeTio, nomeTia);
    const telefoneCasalAtual = montarTelefoneCasalExterno(telefoneTio, telefoneTia);
    const nomesBusca = Array.from(new Set([nomeCasalAtual, ...(aliasesNomes || [])].map((item) => String(item || '').trim()).filter(Boolean)));
    const comTioCasalIdMontagem = await ensureMontagemMembrosTioCasalColumn();
    const comPapelBase = await hasColumn('equipes_funcoes', 'papel_base');

    const [servicosRows] = await pool.query(
        `SELECT
            cs.equipe_id,
            cs.ejc_id,
            COALESCE(e.numero, m_origem.numero_ejc) AS numero_ejc,
            m_destino.id AS montagem_id
         FROM tios_casal_servicos cs
         LEFT JOIN ejc e
           ON e.id = cs.ejc_id
          AND e.tenant_id = cs.tenant_id
         LEFT JOIN montagens m_origem
           ON m_origem.id = cs.ejc_id
          AND m_origem.tenant_id = cs.tenant_id
         LEFT JOIN montagens m_destino
           ON m_destino.numero_ejc = COALESCE(e.numero, m_origem.numero_ejc)
          AND m_destino.tenant_id = cs.tenant_id
         WHERE cs.tenant_id = ?
           AND cs.casal_id = ?`,
        [tenantId, casalId]
    );

    const equipeIds = Array.from(new Set((servicosRows || []).map((item) => Number(item.equipe_id)).filter((id) => id > 0)));
    const funcaoPorEquipe = new Map();
    if (equipeIds.length) {
        const [funcoesRows] = await pool.query(
            `SELECT
                id,
                equipe_id,
                nome,
                ${comPapelBase ? "COALESCE(papel_base, 'Membro')" : "'Membro'"} AS papel_base
             FROM equipes_funcoes
             WHERE tenant_id = ?
               AND equipe_id IN (${equipeIds.map(() => '?').join(',')})
             ORDER BY equipe_id ASC, nome ASC`,
            [tenantId, ...equipeIds]
        );

        const agrupadas = new Map();
        for (const row of (funcoesRows || [])) {
            const equipeId = Number(row.equipe_id);
            if (!equipeId) continue;
            if (!agrupadas.has(equipeId)) agrupadas.set(equipeId, []);
            agrupadas.get(equipeId).push(row);
        }
        for (const [equipeId, funcoes] of agrupadas.entries()) {
            const escolhida = escolherFuncaoTio(funcoes);
            if (escolhida) funcaoPorEquipe.set(equipeId, escolhida);
        }
    }

    const desejados = new Map();
    for (const servico of (servicosRows || [])) {
        const equipeId = Number(servico && servico.equipe_id);
        const montagemId = Number(servico && servico.montagem_id);
        if (!equipeId || !montagemId) continue;
        const funcao = funcaoPorEquipe.get(equipeId);
        if (!funcao || !funcao.id) continue;
        const chave = `${montagemId}:${equipeId}:${Number(funcao.id)}`;
        if (!desejados.has(chave)) {
            desejados.set(chave, {
                montagemId,
                equipeId,
                funcaoId: Number(funcao.id)
            });
        }
    }

    let existentes = [];
    if (comTioCasalIdMontagem || nomesBusca.length) {
        const paramsExistentes = [tenantId];
        const filtrosIdentificacao = [];
        if (comTioCasalIdMontagem) {
            filtrosIdentificacao.push('mm.tio_casal_id = ?');
            paramsExistentes.push(casalId);
        }
        if (nomesBusca.length) {
            filtrosIdentificacao.push(`(mm.tio_casal_id IS NULL AND TRIM(COALESCE(mm.nome_externo, '')) IN (${nomesBusca.map(() => '?').join(',')}))`);
            paramsExistentes.push(...nomesBusca);
        }
        const [rows] = await pool.query(
            `SELECT
                mm.id,
                mm.montagem_id,
                mm.equipe_id,
                mm.funcao_id
             FROM montagem_membros mm
             JOIN equipes_funcoes ef
               ON ef.id = mm.funcao_id
              AND ef.tenant_id = mm.tenant_id
             WHERE mm.tenant_id = ?
               AND mm.jovem_id IS NULL
               AND COALESCE(mm.eh_substituicao, 0) = 0
               AND (${filtrosIdentificacao.join(' OR ')})
               AND ${
                   comPapelBase
                       ? "(COALESCE(ef.papel_base, 'Membro') = 'Tio' OR LOWER(COALESCE(ef.nome, '')) LIKE '%tio%' OR LOWER(COALESCE(ef.nome, '')) LIKE '%tia%')"
                       : "(LOWER(COALESCE(ef.nome, '')) LIKE '%tio%' OR LOWER(COALESCE(ef.nome, '')) LIKE '%tia%')"
               }`,
            paramsExistentes
        );
        existentes = Array.isArray(rows) ? rows : [];
    }

    const existentesPorChave = new Map();
    for (const row of existentes) {
        const chave = `${Number(row.montagem_id)}:${Number(row.equipe_id)}:${Number(row.funcao_id)}`;
        if (!existentesPorChave.has(chave)) {
            existentesPorChave.set(chave, row);
            continue;
        }
        await pool.query('DELETE FROM montagem_membros WHERE id = ? AND tenant_id = ?', [row.id, tenantId]);
    }

    for (const [chave, row] of existentesPorChave.entries()) {
        if (!desejados.has(chave)) {
            await pool.query('DELETE FROM montagem_membros WHERE id = ? AND tenant_id = ?', [row.id, tenantId]);
            continue;
        }
        const sets = ['nome_externo = ?', 'telefone_externo = ?'];
        const paramsAtualizacao = [nomeCasalAtual || null, telefoneCasalAtual];
        if (comTioCasalIdMontagem) {
            sets.push('tio_casal_id = ?');
            paramsAtualizacao.push(casalId);
        }
        paramsAtualizacao.push(row.id, tenantId);
        await pool.query(
            `UPDATE montagem_membros
             SET ${sets.join(', ')}
             WHERE id = ?
               AND tenant_id = ?`,
            paramsAtualizacao
        );
        desejados.delete(chave);
    }

    for (const item of desejados.values()) {
        if (comTioCasalIdMontagem) {
            await pool.query(
                `INSERT INTO montagem_membros
                    (tenant_id, montagem_id, equipe_id, funcao_id, jovem_id, tio_casal_id, eh_substituicao, ordem_reserva, nome_externo, telefone_externo)
                 VALUES (?, ?, ?, ?, NULL, ?, 0, NULL, ?, ?)`,
                [tenantId, item.montagemId, item.equipeId, item.funcaoId, casalId, nomeCasalAtual || null, telefoneCasalAtual]
            );
            continue;
        }
        await pool.query(
            `INSERT INTO montagem_membros
                (tenant_id, montagem_id, equipe_id, funcao_id, jovem_id, eh_substituicao, ordem_reserva, nome_externo, telefone_externo)
             VALUES (?, ?, ?, ?, NULL, 0, NULL, ?, ?)`,
            [tenantId, item.montagemId, item.equipeId, item.funcaoId, nomeCasalAtual || null, telefoneCasalAtual]
        );
    }
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

async function ensureMontagemMembrosTioCasalColumn() {
    if (!await hasTable('montagem_membros')) return false;
    if (await hasColumn('montagem_membros', 'tio_casal_id')) return true;
    try {
        await pool.query('ALTER TABLE montagem_membros ADD COLUMN tio_casal_id INT NULL AFTER jovem_id');
    } catch (err) {
        if (!err || err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
    try {
        await pool.query('ALTER TABLE montagem_membros ADD KEY idx_montagem_membros_tio_casal (tio_casal_id)');
    } catch (err) {
        if (!err || err.code !== 'ER_DUP_KEYNAME') throw err;
    }
    return hasColumn('montagem_membros', 'tio_casal_id');
}

async function ensureListaMestreAtivoColumn() {
    if (ensureListaMestreAtivoPromise) return ensureListaMestreAtivoPromise;
    ensureListaMestreAtivoPromise = (async () => {
        if (await hasColumn('jovens', 'lista_mestre_ativo')) return;
        try {
            await pool.query("ALTER TABLE jovens ADD COLUMN lista_mestre_ativo TINYINT(1) NOT NULL DEFAULT 1");
        } catch (err) {
            if (!err || err.code !== 'ER_DUP_FIELDNAME') throw err;
        }
    })();
    try {
        await ensureListaMestreAtivoPromise;
    } finally {
        ensureListaMestreAtivoPromise = null;
    }
}

async function ensureStructure() {
    if (ensured) return;
    if (ensurePromise) return ensurePromise;
    ensurePromise = (async () => {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tios_ecc (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tenant_id INT NOT NULL,
                numero VARCHAR(30) NOT NULL,
                tipo VARCHAR(10) NOT NULL DEFAULT 'ECC',
                descricao VARCHAR(160) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_tios_ecc_tenant_numero (tenant_id, numero)
            )
        `);
        try {
            await pool.query("ALTER TABLE tios_ecc ADD COLUMN tipo VARCHAR(10) NOT NULL DEFAULT 'ECC' AFTER numero");
        } catch (e) { }
        try {
            await pool.query("ALTER TABLE tios_ecc DROP INDEX uniq_tios_ecc_tenant_numero");
        } catch (e) { }
        try {
            await pool.query("ALTER TABLE tios_ecc ADD UNIQUE KEY uniq_tios_ecc_tenant_numero_tipo (tenant_id, numero, tipo)");
        } catch (e) { }

        await pool.query(`
            CREATE TABLE IF NOT EXISTS tios_casais (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tenant_id INT NOT NULL,
                ecc_id INT NULL,
                origem_tipo ENUM('EJC','OUTRO_EJC') NOT NULL DEFAULT 'EJC',
                outro_ejc_id INT NULL,
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
                KEY idx_tios_casais_ecc (ecc_id),
                KEY idx_tios_casais_outro_ejc (outro_ejc_id)
            )
        `);
        try {
            await pool.query("ALTER TABLE tios_casais ADD COLUMN origem_tipo ENUM('EJC','OUTRO_EJC') NOT NULL DEFAULT 'EJC' AFTER ecc_id");
        } catch (e) { }
        try {
            await pool.query("ALTER TABLE tios_casais ADD COLUMN outro_ejc_id INT NULL AFTER origem_tipo");
        } catch (e) { }
        try {
            await pool.query("ALTER TABLE tios_casais ADD COLUMN restricao_alimentar TINYINT(1) NOT NULL DEFAULT 0 AFTER data_nascimento_tia");
        } catch (e) { }
        try {
            await pool.query("ALTER TABLE tios_casais ADD COLUMN deficiencia TINYINT(1) NOT NULL DEFAULT 0 AFTER restricao_alimentar");
        } catch (e) { }
        try {
            await pool.query("ALTER TABLE tios_casais ADD COLUMN restricao_alimentar_tio TINYINT(1) NOT NULL DEFAULT 0 AFTER deficiencia");
        } catch (e) { }
        try {
            await pool.query("ALTER TABLE tios_casais ADD COLUMN detalhes_restricao_tio VARCHAR(255) NULL AFTER restricao_alimentar_tio");
        } catch (e) { }
        try {
            await pool.query("ALTER TABLE tios_casais ADD COLUMN deficiencia_tio TINYINT(1) NOT NULL DEFAULT 0 AFTER detalhes_restricao_tio");
        } catch (e) { }
        try {
            await pool.query("ALTER TABLE tios_casais ADD COLUMN qual_deficiencia_tio VARCHAR(255) NULL AFTER deficiencia_tio");
        } catch (e) { }
        try {
            await pool.query("ALTER TABLE tios_casais ADD COLUMN restricao_alimentar_tia TINYINT(1) NOT NULL DEFAULT 0 AFTER qual_deficiencia_tio");
        } catch (e) { }
        try {
            await pool.query("ALTER TABLE tios_casais ADD COLUMN detalhes_restricao_tia VARCHAR(255) NULL AFTER restricao_alimentar_tia");
        } catch (e) { }
        try {
            await pool.query("ALTER TABLE tios_casais ADD COLUMN deficiencia_tia TINYINT(1) NOT NULL DEFAULT 0 AFTER detalhes_restricao_tia");
        } catch (e) { }
        try {
            await pool.query("ALTER TABLE tios_casais ADD COLUMN qual_deficiencia_tia VARCHAR(255) NULL AFTER deficiencia_tia");
        } catch (e) { }
        try {
            await pool.query("ALTER TABLE tios_casais ADD COLUMN termos_aceitos_em DATETIME NULL AFTER observacoes");
        } catch (e) { }
        try {
            await pool.query("ALTER TABLE tios_casais ADD COLUMN foto_url VARCHAR(255) NULL AFTER observacoes");
        } catch (e) { }
        await pool.query(`
            UPDATE tios_casais
               SET restricao_alimentar_tio = CASE WHEN restricao_alimentar = 1 THEN 1 ELSE restricao_alimentar_tio END,
                   restricao_alimentar_tia = CASE WHEN restricao_alimentar = 1 THEN 1 ELSE restricao_alimentar_tia END,
                   deficiencia_tio = CASE WHEN deficiencia = 1 THEN 1 ELSE deficiencia_tio END,
                   deficiencia_tia = CASE WHEN deficiencia = 1 THEN 1 ELSE deficiencia_tia END
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS tios_casal_equipes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tenant_id INT NOT NULL,
                casal_id INT NOT NULL,
                equipe_id INT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_tios_casal_equipe (casal_id, equipe_id),
                KEY idx_tios_casal_equipes_tenant (tenant_id)
            )
        `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS tios_casal_servicos (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            casal_id INT NOT NULL,
                equipe_id INT NOT NULL,
                ejc_id INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_tios_casal_servico (casal_id, equipe_id, ejc_id),
                KEY idx_tios_casal_servicos_tenant (tenant_id),
                KEY idx_tios_casal_servicos_ejc (ejc_id)
        )
    `);

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

        await pool.query(`
            CREATE TABLE IF NOT EXISTS tios_observacoes_extras (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tenant_id INT NOT NULL,
                casal_id INT NOT NULL,
                observacao TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                KEY idx_tios_obs_tenant_casal (tenant_id, casal_id)
            )
        `);

        await pool.query(`
            INSERT INTO tios_casal_servicos (tenant_id, casal_id, equipe_id, ejc_id)
            SELECT ce.tenant_id, ce.casal_id, ce.equipe_id, NULL
            FROM tios_casal_equipes ce
            LEFT JOIN tios_casal_servicos cs
              ON cs.tenant_id = ce.tenant_id
             AND cs.casal_id = ce.casal_id
             AND cs.equipe_id = ce.equipe_id
             AND cs.ejc_id IS NULL
            WHERE cs.id IS NULL
        `);

        ensured = true;
    })();

    try {
        await ensurePromise;
    } finally {
        ensurePromise = null;
    }
    await ensureTiosServicosSnapshots();
}

function normalizeDate(v) {
    if (!v) return null;
    const txt = String(v).trim();
    if (!txt) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(txt)) return txt;
    if (txt.includes('T')) return txt.split('T')[0];
    return null;
}

function toIntArray(value) {
    if (!Array.isArray(value)) return [];
    return value.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0);
}

function normalizeServicos(value, fallbackEquipeIds) {
    const result = [];
    const seen = new Set();
    if (Array.isArray(value)) {
        for (const item of value) {
            const equipeId = Number(item && item.equipe_id);
            const ejcIdRaw = item ? item.ejc_id : null;
            const ejcId = ejcIdRaw ? Number(ejcIdRaw) : null;
            if (!Number.isInteger(equipeId) || equipeId <= 0) continue;
            const validEjcId = Number.isInteger(ejcId) && ejcId > 0 ? ejcId : null;
            const key = `${equipeId}:${validEjcId || 0}`;
            if (seen.has(key)) continue;
            seen.add(key);
            result.push({ equipe_id: equipeId, ejc_id: validEjcId });
        }
    }

    if (result.length) return result;

    for (const equipeId of toIntArray(fallbackEquipeIds)) {
        const key = `${equipeId}:0`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ equipe_id: equipeId, ejc_id: null });
    }
    return result;
}

function parseBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v === 1;
    const txt = String(v || '').trim().toLowerCase();
    return txt === '1' || txt === 'true' || txt === 'sim' || txt === 'yes';
}

function normalizePhoneDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function normalizedPhoneExpr(fieldName) {
    return NORMALIZED_PHONE_SQL.replace('%FIELD%', fieldName);
}

function normalizeTrimmedText(value) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text || null;
}

function normalizeUpperText(value) {
    const text = normalizeTrimmedText(value);
    return text ? text.toLocaleUpperCase('pt-BR') : null;
}

async function validarDuplicidadeTelefoneCasal({
    tenantId,
    telefoneTio,
    telefoneTia,
    excludeCasalId = null,
    connection = pool
}) {
    const telefoneTioNormalizado = normalizePhoneDigits(telefoneTio);
    const telefoneTiaNormalizado = normalizePhoneDigits(telefoneTia);

    if (telefoneTioNormalizado && telefoneTiaNormalizado && telefoneTioNormalizado === telefoneTiaNormalizado) {
        return {
            campo: 'telefone_tia',
            error: 'Os telefones do tio e da tia não podem ser iguais.'
        };
    }

    const telefonesParaValidar = [
        { campo: 'telefone_tio', label: 'Telefone do tio', valor: telefoneTioNormalizado },
        { campo: 'telefone_tia', label: 'Telefone da tia', valor: telefoneTiaNormalizado }
    ];

    for (const item of telefonesParaValidar) {
        if (!item.valor) continue;

        const params = [tenantId, item.valor, item.valor];
        let sql = `
            SELECT id, nome_tio, nome_tia
            FROM tios_casais
            WHERE tenant_id = ?
              AND (
                    ${normalizedPhoneExpr('telefone_tio')} = ?
                 OR ${normalizedPhoneExpr('telefone_tia')} = ?
              )
        `;

        if (excludeCasalId) {
            sql += ' AND id <> ?';
            params.push(Number(excludeCasalId));
        }

        sql += ' LIMIT 1';
        const [rows] = await connection.query(sql, params);
        if (rows && rows.length) {
            const nomeCasal = [rows[0].nome_tio, rows[0].nome_tia].filter(Boolean).join(' e ') || 'outro casal';
            return {
                campo: item.campo,
                error: `${item.label} já está cadastrado em ${nomeCasal}.`
            };
        }
    }

    return null;
}

async function buscarJovemPorNomeTelefone({ tenantId, nome, telefone }) {
    const nomeTxt = String(nome || '').trim();
    const telefoneDigits = normalizePhoneDigits(telefone);
    if (!nomeTxt) return null;

    let sql = `
        SELECT id
        FROM jovens
        WHERE tenant_id = ?
          AND LOWER(TRIM(nome_completo)) = LOWER(TRIM(?))
    `;
    const params = [tenantId, nomeTxt];

    if (telefoneDigits) {
        sql += `
          AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(COALESCE(telefone, '')), ' ', ''), '(', ''), ')', ''), '-', ''), '+', '') = ?
        `;
        params.push(telefoneDigits);
    }

    sql += ' ORDER BY id DESC LIMIT 1';
    const [rows] = await pool.query(sql, params);
    return rows && rows[0] ? Number(rows[0].id) : null;
}

async function sincronizarCasalComListaMestre({ tenantId, casalId, nomeTio, telefoneTio, nomeTia, telefoneTia }) {
    await ensureStructure();
    await ensureListaMestreAtivoColumn();

    const tioId = await buscarJovemPorNomeTelefone({ tenantId, nome: nomeTio, telefone: telefoneTio });
    const tiaId = await buscarJovemPorNomeTelefone({ tenantId, nome: nomeTia, telefone: telefoneTia });
    const ids = [tioId, tiaId].filter((id) => Number.isInteger(id) && id > 0);
    if (!ids.length) return;

    await pool.query(
        `UPDATE jovens
         SET lista_mestre_ativo = 0,
             circulo = NULL
         WHERE tenant_id = ?
           AND id IN (${ids.map(() => '?').join(',')})`,
        [tenantId, ...ids]
    );

    for (const jovemId of ids) {
        // eslint-disable-next-line no-await-in-loop
        await pool.query(
            `INSERT INTO tios_jovens (tenant_id, casal_id, jovem_id)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE casal_id = VALUES(casal_id)`,
            [tenantId, casalId, jovemId]
        );
    }
}

router.get('/equipes', async (req, res) => {
    try {
        await ensureStructure();
        const tenantId = getTenantId(req);
        const [rows] = await pool.query(
            'SELECT id, nome FROM equipes WHERE tenant_id = ? ORDER BY nome ASC',
            [tenantId]
        );
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar equipes para tios:', err);
        return res.status(500).json({ error: 'Erro ao listar equipes.' });
    }
});

router.get('/ejcs', async (req, res) => {
    try {
        await ensureStructure();
        const tenantId = getTenantId(req);
        const [rows] = await pool.query(
            'SELECT id, numero, paroquia, ano FROM ejc WHERE tenant_id = ? ORDER BY numero DESC',
            [tenantId]
        );
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar EJCs para tios:', err);
        return res.status(500).json({ error: 'Erro ao listar EJCs.' });
    }
});

router.get('/ecc', async (req, res) => {
    try {
        await ensureStructure();
        const tenantId = getTenantId(req);
        const [rows] = await pool.query(
            `SELECT id, numero, tipo, descricao, created_at, updated_at
             FROM tios_ecc
             WHERE tenant_id = ?
             ORDER BY numero ASC`,
            [tenantId]
        );
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar ECC:', err);
        return res.status(500).json({ error: 'Erro ao listar ECC.' });
    }
});

router.post('/ecc', async (req, res) => {
    try {
        await ensureStructure();
        const tenantId = getTenantId(req);
        const numero = String(req.body.numero || '').trim();
        const descricao = String(req.body.descricao || '').trim() || null;
        const tipoRaw = String(req.body.tipo || 'ECC').trim().toUpperCase();
        const tipo = tipoRaw === 'ECNA' ? 'ECNA' : 'ECC';
        if (!numero) return res.status(400).json({ error: 'Número do ECC é obrigatório.' });
        const [exists] = await pool.query(
            'SELECT id FROM tios_ecc WHERE tenant_id = ? AND numero = ? AND tipo = ? LIMIT 1',
            [tenantId, numero, tipo]
        );
        if (exists.length) return res.status(400).json({ error: 'Esse número já está cadastrado para este encontro.' });
        const [result] = await pool.query(
            'INSERT INTO tios_ecc (tenant_id, numero, tipo, descricao) VALUES (?, ?, ?, ?)',
            [tenantId, numero, tipo, descricao]
        );
        return res.status(201).json({ id: result.insertId, message: 'ECC cadastrado com sucesso.' });
    } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Esse número de ECC já está cadastrado.' });
        }
        console.error('Erro ao criar ECC:', err);
        return res.status(500).json({ error: 'Erro ao criar ECC.' });
    }
});

// Presenças por casal de tios
router.get('/presencas/:casalId', async (req, res) => {
    try {
        await ensureStructure();
        const tenantId = getTenantId(req);
        const casalId = Number(req.params.casalId);
        if (!Number.isInteger(casalId) || casalId <= 0) {
            return res.status(400).json({ error: 'Casal inválido.' });
        }
        const hasPresencas = await hasTable('formularios_presencas');
        const hasForms = await hasTable('formularios_itens');
        if (!hasPresencas || !hasForms) return res.json([]);
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
            WHERE fp.tenant_id = ?
              AND fp.tio_casal_id = ?
            ORDER BY fp.registrado_em DESC
        `, [tenantId, casalId]);

        return res.json(rows);
    } catch (err) {
        console.error('Erro ao buscar presenças do casal:', err);
        return res.status(500).json({ error: 'Erro ao buscar presenças.' });
    }
});

// Jovens vinculados ao casal
router.get('/:casalId/jovens', async (req, res) => {
    try {
        await ensureStructure();
        const tenantId = getTenantId(req);
        const casalId = Number(req.params.casalId);
        if (!casalId) return res.status(400).json({ error: 'ID inválido.' });
        const [rows] = await pool.query(
            `SELECT tj.id, tj.jovem_id, j.nome_completo, j.telefone, j.circulo, j.data_nascimento
             FROM tios_jovens tj
             JOIN jovens j ON j.id = tj.jovem_id
             WHERE tj.tenant_id = ? AND tj.casal_id = ?
             ORDER BY j.nome_completo ASC`,
            [tenantId, casalId]
        );
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar jovens do casal:', err);
        return res.status(500).json({ error: 'Erro ao listar jovens.' });
    }
});

router.get('/casais/:casalId/observacoes', async (req, res) => {
    try {
        await ensureStructure();
        const tenantId = getTenantId(req);
        const casalId = Number(req.params.casalId);
        if (!casalId) return res.status(400).json({ error: 'ID inválido.' });
        const [rows] = await pool.query(
            `SELECT id, observacao, created_at
             FROM tios_observacoes_extras
             WHERE tenant_id = ? AND casal_id = ?
             ORDER BY created_at DESC, id DESC`,
            [tenantId, casalId]
        );
        return res.json(rows || []);
    } catch (err) {
        console.error('Erro ao listar observações extras de tios:', err);
        return res.status(500).json({ error: 'Erro ao listar observações.' });
    }
});

router.post('/casais/:casalId/observacoes', async (req, res) => {
    try {
        await ensureStructure();
        const tenantId = getTenantId(req);
        const casalId = Number(req.params.casalId);
        const observacao = String(req.body && req.body.observacao || '').trim();
        if (!casalId) return res.status(400).json({ error: 'ID inválido.' });
        if (!observacao) return res.status(400).json({ error: 'Informe a observação.' });

        const [casalRows] = await pool.query(
            'SELECT id FROM tios_casais WHERE id = ? AND tenant_id = ? LIMIT 1',
            [casalId, tenantId]
        );
        if (!casalRows.length) return res.status(404).json({ error: 'Casal não encontrado.' });

        const [result] = await pool.query(
            `INSERT INTO tios_observacoes_extras (tenant_id, casal_id, observacao)
             VALUES (?, ?, ?)`,
            [tenantId, casalId, observacao]
        );
        return res.status(201).json({ id: result.insertId, message: 'Observação adicionada com sucesso.' });
    } catch (err) {
        console.error('Erro ao criar observação extra de tios:', err);
        return res.status(500).json({ error: 'Erro ao salvar observação.' });
    }
});

router.post('/:casalId/jovens', async (req, res) => {
    try {
        await ensureStructure();
        const tenantId = getTenantId(req);
        const casalId = Number(req.params.casalId);
        const jovemId = Number(req.body && req.body.jovem_id);
        if (!casalId || !jovemId) return res.status(400).json({ error: 'Dados inválidos.' });

        const [existe] = await pool.query(
            'SELECT id, casal_id FROM tios_jovens WHERE tenant_id = ? AND jovem_id = ? LIMIT 1',
            [tenantId, jovemId]
        );
        if (existe.length && Number(existe[0].casal_id) !== casalId) {
            return res.status(409).json({ error: 'Esse jovem já tem outro casal de tios.' });
        }
        if (existe.length && Number(existe[0].casal_id) === casalId) {
            return res.json({ message: 'Jovem já vinculado.' });
        }

        await pool.query(
            'INSERT INTO tios_jovens (tenant_id, casal_id, jovem_id) VALUES (?, ?, ?)',
            [tenantId, casalId, jovemId]
        );
        return res.status(201).json({ message: 'Jovem vinculado.' });
    } catch (err) {
        console.error('Erro ao vincular jovem ao casal:', err);
        return res.status(500).json({ error: 'Erro ao vincular jovem.' });
    }
});

router.delete('/:casalId/jovens/:id', async (req, res) => {
    try {
        await ensureStructure();
        const tenantId = getTenantId(req);
        const casalId = Number(req.params.casalId);
        const vinculoId = Number(req.params.id);
        if (!casalId || !vinculoId) return res.status(400).json({ error: 'ID inválido.' });
        await pool.query(
            'DELETE FROM tios_jovens WHERE id = ? AND casal_id = ? AND tenant_id = ?',
            [vinculoId, casalId, tenantId]
        );
        return res.json({ message: 'Vínculo removido.' });
    } catch (err) {
        console.error('Erro ao remover vínculo do jovem:', err);
        return res.status(500).json({ error: 'Erro ao remover vínculo.' });
    }
});

router.put('/ecc/:id', async (req, res) => {
    try {
        await ensureStructure();
        const tenantId = getTenantId(req);
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ error: 'ID inválido.' });
        const numero = String(req.body.numero || '').trim();
        const descricao = String(req.body.descricao || '').trim() || null;
        const tipoRaw = String(req.body.tipo || 'ECC').trim().toUpperCase();
        const tipo = tipoRaw === 'ECNA' ? 'ECNA' : 'ECC';
        if (!numero) return res.status(400).json({ error: 'Número do ECC é obrigatório.' });
        const [exists] = await pool.query(
            'SELECT id FROM tios_ecc WHERE tenant_id = ? AND numero = ? AND tipo = ? AND id <> ? LIMIT 1',
            [tenantId, numero, tipo, id]
        );
        if (exists.length) return res.status(400).json({ error: 'Esse número já está cadastrado para este encontro.' });
        const [result] = await pool.query(
            'UPDATE tios_ecc SET numero = ?, tipo = ?, descricao = ? WHERE id = ? AND tenant_id = ?',
            [numero, tipo, descricao, id, tenantId]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'ECC não encontrado.' });
        return res.json({ message: 'ECC atualizado com sucesso.' });
    } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Esse número de ECC já está cadastrado.' });
        }
        console.error('Erro ao atualizar ECC:', err);
        return res.status(500).json({ error: 'Erro ao atualizar ECC.' });
    }
});

router.delete('/ecc/:id', async (req, res) => {
    try {
        await ensureStructure();
        const tenantId = getTenantId(req);
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ error: 'ID inválido.' });
        const [used] = await pool.query(
            'SELECT id FROM tios_casais WHERE tenant_id = ? AND ecc_id = ? LIMIT 1',
            [tenantId, id]
        );
        if (used.length) return res.status(400).json({ error: 'Não é possível excluir: ECC em uso por casal cadastrado.' });
        const [result] = await pool.query('DELETE FROM tios_ecc WHERE id = ? AND tenant_id = ?', [id, tenantId]);
        if (!result.affectedRows) return res.status(404).json({ error: 'ECC não encontrado.' });
        return res.json({ message: 'ECC removido com sucesso.' });
    } catch (err) {
        console.error('Erro ao remover ECC:', err);
        return res.status(500).json({ error: 'Erro ao remover ECC.' });
    }
});

router.get('/casais/:casalId/comissoes', async (req, res) => {
    try {
        await ensureStructure();
        const tenantId = getTenantId(req);
        const casalId = Number(req.params.casalId);
        if (!Number.isInteger(casalId) || casalId <= 0) {
            return res.status(400).json({ error: 'Casal inválido.' });
        }

        const [rows] = await pool.query(`
            SELECT 
                cm.id AS coordenacao_membro_id,
                cm.comissao_id,
                'COORDENACAO' AS tipo,
                c.id AS coordenacao_id,
                c.nome AS coordenacao_nome,
                c.periodo AS coordenacao_periodo,
                c.pasta_id AS coordenacao_pasta_id,
                p.nome AS coordenacao_pasta_nome,
                p.parent_id AS coordenacao_pasta_parent_id,
                jc.id,
                jc.ejc_numero,
                jc.paroquia,
                jc.data_inicio,
                jc.data_fim,
                jc.funcao_garcom,
                jc.semestre,
                jc.circulo,
                jc.observacao,
                oe.nome AS outro_ejc_nome,
                oe.paroquia AS outro_ejc_paroquia
            FROM coordenacoes_membros cm
            JOIN coordenacoes c ON c.id = cm.coordenacao_id AND c.tenant_id = cm.tenant_id
            LEFT JOIN jovens_comissoes jc ON jc.id = cm.comissao_id AND jc.tenant_id = cm.tenant_id
            LEFT JOIN outros_ejcs oe ON jc.outro_ejc_id = oe.id AND oe.tenant_id = jc.tenant_id
            LEFT JOIN coordenacoes_pastas p ON p.id = c.pasta_id
            WHERE cm.tenant_id = ?
              AND cm.membro_tipo = 'TIO'
              AND cm.tio_casal_id = ?
            ORDER BY c.created_at DESC, cm.id DESC
        `, [tenantId, casalId]);

        let garcomRows = [];
        if (await hasTable('garcons_membros') && await hasTable('garcons_equipes')) {
            const [rowsGarcom] = await pool.query(`
                SELECT
                    CONCAT('garcom-tio-', gm.id) AS coordenacao_membro_id,
                    gm.comissao_id,
                    'GARCOM_EQUIPE' AS tipo,
                    NULL AS coordenacao_id,
                    NULL AS coordenacao_nome,
                    NULL AS coordenacao_periodo,
                    NULL AS coordenacao_pasta_id,
                    NULL AS coordenacao_pasta_nome,
                    NULL AS coordenacao_pasta_parent_id,
                    gm.id,
                    ge.ejc_numero,
                    NULL AS paroquia,
                    ge.data_inicio,
                    ge.data_fim,
                    gm.papel AS funcao_garcom,
                    NULL AS semestre,
                    NULL AS circulo,
                    'Equipe de Garçom' AS observacao,
                    oe.nome AS outro_ejc_nome,
                    oe.paroquia AS outro_ejc_paroquia
                FROM garcons_membros gm
                JOIN garcons_equipes ge ON ge.id = gm.equipe_id
                LEFT JOIN outros_ejcs oe ON oe.id = ge.outro_ejc_id
                WHERE gm.membro_tipo = 'TIO'
                  AND gm.tio_casal_id = ?
                ORDER BY gm.created_at DESC, gm.id DESC
            `, [casalId]);
            garcomRows = rowsGarcom || [];
        }

        const idsPasta = [...new Set(
            (rows || [])
                .map(r => Number(r.coordenacao_pasta_id))
                .filter(v => Number.isFinite(v) && v > 0)
        )];

        let pastasMap = new Map();
        if (idsPasta.length) {
            const [pastas] = await pool.query(
                'SELECT id, nome, parent_id FROM coordenacoes_pastas WHERE tenant_id = ?',
                [tenantId]
            );
            pastasMap = new Map((pastas || []).map((p) => [Number(p.id), p]));
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

        res.json([...(rows || []), ...garcomRows].map((r) => ({
            ...r,
            id: r.id || `coord-tio-${r.coordenacao_membro_id}`,
            coordenacao_pasta_caminho: montarCaminho(r.coordenacao_pasta_id)
        })));
    } catch (err) {
        console.error('Erro ao buscar comissões do casal de tios:', err);
        return res.status(500).json({ error: 'Erro ao buscar comissões.' });
    }
});

router.get('/casais', async (req, res) => {
    try {
        await ensureStructure();
        const tenantId = getTenantId(req);
        const tipo = String(req.query.tipo || '').trim().toUpperCase();
        const whereTipo = tipo === 'OUTRO_EJC'
            ? "AND c.origem_tipo = 'OUTRO_EJC'"
            : tipo === 'EJC'
                ? "AND COALESCE(c.origem_tipo, 'EJC') = 'EJC'"
                : '';
        const [casais] = await pool.query(
            `SELECT c.id, c.ecc_id, c.origem_tipo, c.outro_ejc_id, c.nome_tio, c.telefone_tio, c.data_nascimento_tio,
                    c.nome_tia, c.telefone_tia, c.data_nascimento_tia, c.restricao_alimentar, c.deficiencia,
                    c.restricao_alimentar_tio, c.detalhes_restricao_tio, c.deficiencia_tio, c.qual_deficiencia_tio,
                    c.restricao_alimentar_tia, c.detalhes_restricao_tia, c.deficiencia_tia, c.qual_deficiencia_tia,
                    c.observacoes, c.termos_aceitos_em, c.foto_url,
                    c.created_at, c.updated_at, e.numero AS ecc_numero, e.tipo AS ecc_tipo, e.descricao AS ecc_descricao,
                    oe.nome AS outro_ejc_nome, oe.paroquia AS outro_ejc_paroquia, oe.bairro AS outro_ejc_bairro
             FROM tios_casais c
             LEFT JOIN tios_ecc e ON e.id = c.ecc_id AND e.tenant_id = c.tenant_id
             LEFT JOIN outros_ejcs oe ON oe.id = c.outro_ejc_id AND oe.tenant_id = c.tenant_id
             WHERE c.tenant_id = ?
             ${whereTipo}
             ORDER BY c.nome_tio ASC, c.nome_tia ASC`,
            [tenantId]
        );
        const casalIds = (casais || []).map((c) => c.id).filter(Boolean);
        let servicosRows = [];
        if (casalIds.length) {
            const [rows] = await pool.query(
                `SELECT cs.casal_id, cs.equipe_id, cs.ejc_id, eq.nome AS equipe_nome,
                        COALESCE(e.numero, m.numero_ejc) AS ejc_numero,
                        e.paroquia AS ejc_paroquia
                 FROM tios_casal_servicos cs
                 JOIN equipes eq ON eq.id = cs.equipe_id AND eq.tenant_id = cs.tenant_id
                 LEFT JOIN ejc e ON e.id = cs.ejc_id AND e.tenant_id = cs.tenant_id
                 LEFT JOIN montagens m ON m.id = cs.ejc_id AND m.tenant_id = cs.tenant_id
                 WHERE cs.tenant_id = ? AND cs.casal_id IN (${casalIds.map(() => '?').join(',')})
                 ORDER BY eq.nome ASC, e.numero DESC`,
                [tenantId, ...casalIds]
            );
            servicosRows = rows || [];
        }
        const byCasal = new Map();
        for (const row of servicosRows) {
            if (!byCasal.has(row.casal_id)) byCasal.set(row.casal_id, []);
            byCasal.get(row.casal_id).push({
                equipe_id: row.equipe_id,
                equipe_nome: row.equipe_nome,
                ejc_id: row.ejc_id || null,
                ejc_numero: row.ejc_numero || null,
                ejc_paroquia: row.ejc_paroquia || null
            });
        }

        const payload = (casais || []).map((c) => ({
            ...c,
            servicos: byCasal.get(c.id) || [],
            equipes: Array.from(
                new Map((byCasal.get(c.id) || []).map((s) => [s.equipe_id, { id: s.equipe_id, nome: s.equipe_nome }])).values()
            ),
            equipe_ids: Array.from(new Set((byCasal.get(c.id) || []).map((s) => s.equipe_id)))
        }));
        return res.json(payload);
    } catch (err) {
        console.error('Erro ao listar casais de tios:', err);
        return res.status(500).json({ error: 'Erro ao listar casais.' });
    }
});

router.post('/casais', async (req, res) => {
    try {
        await ensureStructure();
        const tenantId = getTenantId(req);
        const nomeTio = normalizeUpperText(req.body.nome_tio);
        const telefoneTio = normalizeTrimmedText(req.body.telefone_tio);
        const dataNascimentoTio = normalizeDate(req.body.data_nascimento_tio);
        const nomeTia = normalizeUpperText(req.body.nome_tia);
        const telefoneTia = normalizeTrimmedText(req.body.telefone_tia);
        const dataNascimentoTia = normalizeDate(req.body.data_nascimento_tia);
        const restricaoAlimentarTio = parseBool(req.body.restricao_alimentar_tio);
        const detalhesRestricaoTio = restricaoAlimentarTio ? (String(req.body.detalhes_restricao_tio || '').trim() || null) : null;
        const deficienciaTio = parseBool(req.body.deficiencia_tio);
        const qualDeficienciaTio = deficienciaTio ? (String(req.body.qual_deficiencia_tio || '').trim() || null) : null;
        const restricaoAlimentarTia = parseBool(req.body.restricao_alimentar_tia);
        const detalhesRestricaoTia = restricaoAlimentarTia ? (String(req.body.detalhes_restricao_tia || '').trim() || null) : null;
        const deficienciaTia = parseBool(req.body.deficiencia_tia);
        const qualDeficienciaTia = deficienciaTia ? (String(req.body.qual_deficiencia_tia || '').trim() || null) : null;
        const restricaoAlimentar = restricaoAlimentarTio || restricaoAlimentarTia;
        const deficiencia = deficienciaTio || deficienciaTia;
        const observacoes = String(req.body.observacoes || '').trim() || null;
        const origemTipo = String(req.body.origem_tipo || 'EJC').trim().toUpperCase() === 'OUTRO_EJC' ? 'OUTRO_EJC' : 'EJC';
        const eccId = req.body.ecc_id ? Number(req.body.ecc_id) : null;
        const outroEjcId = req.body.outro_ejc_id ? Number(req.body.outro_ejc_id) : null;
        const servicos = normalizeServicos(req.body.servicos, req.body.equipe_ids);
        const equipeIds = Array.from(new Set(servicos.map((s) => s.equipe_id)));
        const ejcIds = Array.from(new Set(servicos.map((s) => s.ejc_id).filter((id) => Number.isInteger(id) && id > 0)));

        if (!nomeTio || !telefoneTio || !nomeTia || !telefoneTia) {
            return res.status(400).json({ error: 'Dados obrigatórios: nome e telefone de tio e tia.' });
        }

        const duplicidade = await validarDuplicidadeTelefoneCasal({
            tenantId,
            telefoneTio,
            telefoneTia
        });
        if (duplicidade) {
            return res.status(409).json({ error: duplicidade.error, campo: duplicidade.campo });
        }

        if (origemTipo === 'EJC' && eccId) {
            const [eccRows] = await pool.query('SELECT id FROM tios_ecc WHERE id = ? AND tenant_id = ? LIMIT 1', [eccId, tenantId]);
            if (!eccRows.length) return res.status(400).json({ error: 'ECC inválido.' });
        }
        if (origemTipo === 'OUTRO_EJC') {
            if (!outroEjcId) return res.status(400).json({ error: 'Selecione a paróquia de outro EJC.' });
            const [outroRows] = await pool.query('SELECT id FROM outros_ejcs WHERE id = ? AND tenant_id = ? LIMIT 1', [outroEjcId, tenantId]);
            if (!outroRows.length) return res.status(400).json({ error: 'Outro EJC inválido.' });
        }

        if (equipeIds.length) {
            const [validEquipes] = await pool.query(
                `SELECT id FROM equipes WHERE tenant_id = ? AND id IN (${equipeIds.map(() => '?').join(',')})`,
                [tenantId, ...equipeIds]
            );
            if ((validEquipes || []).length !== equipeIds.length) {
                return res.status(400).json({ error: 'Uma ou mais equipes informadas são inválidas.' });
            }
        }

        if (ejcIds.length) {
            const [validEjcs] = await pool.query(
                `SELECT id FROM ejc WHERE tenant_id = ? AND id IN (${ejcIds.map(() => '?').join(',')})`,
                [tenantId, ...ejcIds]
            );
            if ((validEjcs || []).length !== ejcIds.length) {
                return res.status(400).json({ error: 'Uma ou mais edições do EJC informadas são inválidas.' });
            }
        }

        const [result] = await pool.query(
            `INSERT INTO tios_casais
                (tenant_id, ecc_id, origem_tipo, outro_ejc_id, nome_tio, telefone_tio, data_nascimento_tio, nome_tia, telefone_tia, data_nascimento_tia,
                 restricao_alimentar, deficiencia,
                 restricao_alimentar_tio, detalhes_restricao_tio, deficiencia_tio, qual_deficiencia_tio,
                 restricao_alimentar_tia, detalhes_restricao_tia, deficiencia_tia, qual_deficiencia_tia, observacoes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                tenantId, origemTipo === 'EJC' ? eccId : null, origemTipo, origemTipo === 'OUTRO_EJC' ? outroEjcId : null,
                nomeTio, telefoneTio, dataNascimentoTio, nomeTia, telefoneTia, dataNascimentoTia,
                restricaoAlimentar ? 1 : 0, deficiencia ? 1 : 0,
                restricaoAlimentarTio ? 1 : 0, detalhesRestricaoTio, deficienciaTio ? 1 : 0, qualDeficienciaTio,
                restricaoAlimentarTia ? 1 : 0, detalhesRestricaoTia, deficienciaTia ? 1 : 0, qualDeficienciaTia, observacoes
            ]
        );
        const casalId = result.insertId;

        for (const equipeId of equipeIds) {
            // eslint-disable-next-line no-await-in-loop
            await pool.query(
                'INSERT IGNORE INTO tios_casal_equipes (tenant_id, casal_id, equipe_id) VALUES (?, ?, ?)',
                [tenantId, casalId, equipeId]
            );
        }
        for (const servico of servicos) {
            // eslint-disable-next-line no-await-in-loop
            await pool.query(
                `INSERT IGNORE INTO tios_casal_servicos
                    (tenant_id, casal_id, equipe_id, ejc_id, nome_tio_snapshot, telefone_tio_snapshot, nome_tia_snapshot, telefone_tia_snapshot)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [tenantId, casalId, servico.equipe_id, servico.ejc_id, nomeTio, telefoneTio, nomeTia, telefoneTia]
            );
        }

        if (origemTipo === 'EJC') {
            await sincronizarCasalComListaMestre({
                tenantId,
                casalId,
                nomeTio,
                telefoneTio,
                nomeTia,
                telefoneTia
            });
        }

        await sincronizarServicosCasalComMontagem({
            tenantId,
            casalId,
            nomeTio,
            telefoneTio,
            nomeTia,
            telefoneTia
        });

        return res.status(201).json({ id: casalId, message: 'Casal de tios cadastrado com sucesso.' });
    } catch (err) {
        console.error('Erro ao criar casal de tios:', err);
        return res.status(500).json({ error: 'Erro ao criar casal de tios.' });
    }
});

router.put('/casais/:id', async (req, res) => {
    try {
        await ensureStructure();
        const tenantId = getTenantId(req);
        const casalId = Number(req.params.id);
        if (!casalId) return res.status(400).json({ error: 'ID inválido.' });

        const [casalAtualRows] = await pool.query(
            'SELECT nome_tio, telefone_tio, nome_tia, telefone_tia FROM tios_casais WHERE id = ? AND tenant_id = ? LIMIT 1',
            [casalId, tenantId]
        );
        if (!casalAtualRows.length) return res.status(404).json({ error: 'Casal não encontrado.' });
        const casalAtual = casalAtualRows[0] || {};
        const nomeCasalAnterior = montarNomeCasal(casalAtual.nome_tio, casalAtual.nome_tia);

        const nomeTio = normalizeUpperText(req.body.nome_tio);
        const telefoneTio = normalizeTrimmedText(req.body.telefone_tio);
        const dataNascimentoTio = normalizeDate(req.body.data_nascimento_tio);
        const nomeTia = normalizeUpperText(req.body.nome_tia);
        const telefoneTia = normalizeTrimmedText(req.body.telefone_tia);
        const dataNascimentoTia = normalizeDate(req.body.data_nascimento_tia);
        const restricaoAlimentarTio = parseBool(req.body.restricao_alimentar_tio);
        const detalhesRestricaoTio = restricaoAlimentarTio ? (String(req.body.detalhes_restricao_tio || '').trim() || null) : null;
        const deficienciaTio = parseBool(req.body.deficiencia_tio);
        const qualDeficienciaTio = deficienciaTio ? (String(req.body.qual_deficiencia_tio || '').trim() || null) : null;
        const restricaoAlimentarTia = parseBool(req.body.restricao_alimentar_tia);
        const detalhesRestricaoTia = restricaoAlimentarTia ? (String(req.body.detalhes_restricao_tia || '').trim() || null) : null;
        const deficienciaTia = parseBool(req.body.deficiencia_tia);
        const qualDeficienciaTia = deficienciaTia ? (String(req.body.qual_deficiencia_tia || '').trim() || null) : null;
        const restricaoAlimentar = restricaoAlimentarTio || restricaoAlimentarTia;
        const deficiencia = deficienciaTio || deficienciaTia;
        const observacoes = String(req.body.observacoes || '').trim() || null;
        const origemTipo = String(req.body.origem_tipo || 'EJC').trim().toUpperCase() === 'OUTRO_EJC' ? 'OUTRO_EJC' : 'EJC';
        const eccId = req.body.ecc_id ? Number(req.body.ecc_id) : null;
        const outroEjcId = req.body.outro_ejc_id ? Number(req.body.outro_ejc_id) : null;
        const servicos = normalizeServicos(req.body.servicos, req.body.equipe_ids);
        const equipeIds = Array.from(new Set(servicos.map((s) => s.equipe_id)));
        const ejcIds = Array.from(new Set(servicos.map((s) => s.ejc_id).filter((id) => Number.isInteger(id) && id > 0)));

        if (!nomeTio || !telefoneTio || !nomeTia || !telefoneTia) {
            return res.status(400).json({ error: 'Dados obrigatórios: nome e telefone de tio e tia.' });
        }

        const duplicidade = await validarDuplicidadeTelefoneCasal({
            tenantId,
            telefoneTio,
            telefoneTia,
            excludeCasalId: casalId
        });
        if (duplicidade) {
            return res.status(409).json({ error: duplicidade.error, campo: duplicidade.campo });
        }

        if (origemTipo === 'EJC' && eccId) {
            const [eccRows] = await pool.query('SELECT id FROM tios_ecc WHERE id = ? AND tenant_id = ? LIMIT 1', [eccId, tenantId]);
            if (!eccRows.length) return res.status(400).json({ error: 'ECC inválido.' });
        }
        if (origemTipo === 'OUTRO_EJC') {
            if (!outroEjcId) return res.status(400).json({ error: 'Selecione a paróquia de outro EJC.' });
            const [outroRows] = await pool.query('SELECT id FROM outros_ejcs WHERE id = ? AND tenant_id = ? LIMIT 1', [outroEjcId, tenantId]);
            if (!outroRows.length) return res.status(400).json({ error: 'Outro EJC inválido.' });
        }

        if (equipeIds.length) {
            const [validEquipes] = await pool.query(
                `SELECT id FROM equipes WHERE tenant_id = ? AND id IN (${equipeIds.map(() => '?').join(',')})`,
                [tenantId, ...equipeIds]
            );
            if ((validEquipes || []).length !== equipeIds.length) {
                return res.status(400).json({ error: 'Uma ou mais equipes informadas são inválidas.' });
            }
        }

        if (ejcIds.length) {
            const [validEjcs] = await pool.query(
                `SELECT id FROM ejc WHERE tenant_id = ? AND id IN (${ejcIds.map(() => '?').join(',')})`,
                [tenantId, ...ejcIds]
            );
            if ((validEjcs || []).length !== ejcIds.length) {
                return res.status(400).json({ error: 'Uma ou mais edições do EJC informadas são inválidas.' });
            }
        }

        const [result] = await pool.query(
            `UPDATE tios_casais
             SET ecc_id = ?, origem_tipo = ?, outro_ejc_id = ?, nome_tio = ?, telefone_tio = ?, data_nascimento_tio = ?,
                 nome_tia = ?, telefone_tia = ?, data_nascimento_tia = ?,
                 restricao_alimentar = ?, deficiencia = ?,
                 restricao_alimentar_tio = ?, detalhes_restricao_tio = ?, deficiencia_tio = ?, qual_deficiencia_tio = ?,
                 restricao_alimentar_tia = ?, detalhes_restricao_tia = ?, deficiencia_tia = ?, qual_deficiencia_tia = ?,
                 observacoes = ?
             WHERE id = ? AND tenant_id = ?`,
            [
                origemTipo === 'EJC' ? eccId : null, origemTipo, origemTipo === 'OUTRO_EJC' ? outroEjcId : null,
                nomeTio, telefoneTio, dataNascimentoTio, nomeTia, telefoneTia, dataNascimentoTia,
                restricaoAlimentar ? 1 : 0, deficiencia ? 1 : 0,
                restricaoAlimentarTio ? 1 : 0, detalhesRestricaoTio, deficienciaTio ? 1 : 0, qualDeficienciaTio,
                restricaoAlimentarTia ? 1 : 0, detalhesRestricaoTia, deficienciaTia ? 1 : 0, qualDeficienciaTia,
                observacoes, casalId, tenantId
            ]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Casal não encontrado.' });

        await pool.query(
            `UPDATE tios_casal_servicos
             SET nome_tio_snapshot = ?,
                 telefone_tio_snapshot = ?,
                 nome_tia_snapshot = ?,
                 telefone_tia_snapshot = ?
             WHERE casal_id = ?
               AND tenant_id = ?`,
            [nomeTio, telefoneTio, nomeTia, telefoneTia, casalId, tenantId]
        );

        await pool.query('DELETE FROM tios_casal_equipes WHERE casal_id = ? AND tenant_id = ?', [casalId, tenantId]);
        await pool.query('DELETE FROM tios_casal_servicos WHERE casal_id = ? AND tenant_id = ?', [casalId, tenantId]);
        for (const equipeId of equipeIds) {
            // eslint-disable-next-line no-await-in-loop
            await pool.query(
                'INSERT IGNORE INTO tios_casal_equipes (tenant_id, casal_id, equipe_id) VALUES (?, ?, ?)',
                [tenantId, casalId, equipeId]
            );
        }
        for (const servico of servicos) {
            // eslint-disable-next-line no-await-in-loop
            await pool.query(
                `INSERT IGNORE INTO tios_casal_servicos
                    (tenant_id, casal_id, equipe_id, ejc_id, nome_tio_snapshot, telefone_tio_snapshot, nome_tia_snapshot, telefone_tia_snapshot)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [tenantId, casalId, servico.equipe_id, servico.ejc_id, nomeTio, telefoneTio, nomeTia, telefoneTia]
            );
        }

        if (origemTipo === 'EJC') {
            await sincronizarCasalComListaMestre({
                tenantId,
                casalId,
                nomeTio,
                telefoneTio,
                nomeTia,
                telefoneTia
            });
        }

        await sincronizarServicosCasalComMontagem({
            tenantId,
            casalId,
            nomeTio,
            telefoneTio,
            nomeTia,
            telefoneTia,
            aliasesNomes: [nomeCasalAnterior]
        });

        return res.json({ message: 'Casal atualizado com sucesso.' });
    } catch (err) {
        console.error('Erro ao atualizar casal:', err);
        return res.status(500).json({ error: 'Erro ao atualizar casal.' });
    }
});

router.delete('/casais/:id', async (req, res) => {
    try {
        await ensureStructure();
        const tenantId = getTenantId(req);
        const casalId = Number(req.params.id);
        if (!casalId) return res.status(400).json({ error: 'ID inválido.' });
        const [rows] = await pool.query(
            'SELECT foto_url, nome_tio, telefone_tio, nome_tia, telefone_tia FROM tios_casais WHERE id = ? AND tenant_id = ? LIMIT 1',
            [casalId, tenantId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Casal não encontrado.' });

        await pool.query(
            `INSERT INTO tios_casal_servicos_historico
                (tenant_id, casal_id, equipe_id, ejc_id, nome_tio_snapshot, telefone_tio_snapshot, nome_tia_snapshot, telefone_tia_snapshot)
             SELECT
                ts.tenant_id,
                ts.casal_id,
                ts.equipe_id,
                ts.ejc_id,
                COALESCE(ts.nome_tio_snapshot, ?),
                COALESCE(ts.telefone_tio_snapshot, ?),
                COALESCE(ts.nome_tia_snapshot, ?),
                COALESCE(ts.telefone_tia_snapshot, ?)
             FROM tios_casal_servicos ts
             WHERE ts.casal_id = ?
               AND ts.tenant_id = ?`,
            [
                rows[0].nome_tio || null,
                rows[0].telefone_tio || null,
                rows[0].nome_tia || null,
                rows[0].telefone_tia || null,
                casalId,
                tenantId
            ]
        );

        await pool.query('DELETE FROM tios_casal_equipes WHERE casal_id = ? AND tenant_id = ?', [casalId, tenantId]);
        await pool.query('DELETE FROM tios_casal_servicos WHERE casal_id = ? AND tenant_id = ?', [casalId, tenantId]);
        await sincronizarServicosCasalComMontagem({
            tenantId,
            casalId,
            nomeTio: rows[0].nome_tio,
            telefoneTio: rows[0].telefone_tio,
            nomeTia: rows[0].nome_tia,
            telefoneTia: rows[0].telefone_tia,
            aliasesNomes: [montarNomeCasal(rows[0].nome_tio, rows[0].nome_tia)]
        });
        const [result] = await pool.query('DELETE FROM tios_casais WHERE id = ? AND tenant_id = ?', [casalId, tenantId]);
        if (rows.length > 0 && rows[0].foto_url) {
            const relativeFoto = String(rows[0].foto_url).replace(/^\/+/, '');
            const filepath = path.join(__dirname, '..', 'public', relativeFoto);
            fs.unlink(filepath, () => {});
        }
        return res.json({ message: 'Casal removido com sucesso.' });
    } catch (err) {
        console.error('Erro ao remover casal:', err);
        return res.status(500).json({ error: 'Erro ao remover casal.' });
    }
});

router.post('/casais/:id/foto', (req, res) => {
    upload.single('foto')(req, res, async (uploadErr) => {
        if (uploadErr) {
            console.error('Erro no upload da foto do casal:', uploadErr);
            return res.status(400).json({ error: 'Não foi possível enviar a foto.' });
        }
        try {
            await ensureStructure();
            const tenantId = getTenantId(req);
            const casalId = Number(req.params.id);
            if (!casalId) return res.status(400).json({ error: 'ID inválido.' });
            if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado.' });

            const fotoUrl = `/uploads/fotos_tios/${req.file.filename}`;
            const [rows] = await pool.query('SELECT foto_url FROM tios_casais WHERE id = ? AND tenant_id = ? LIMIT 1', [casalId, tenantId]);
            if (!rows.length) {
                fs.unlink(path.join(uploadDirAbs, req.file.filename), () => {});
                return res.status(404).json({ error: 'Casal não encontrado.' });
            }

            if (rows[0].foto_url) {
                const relativeFoto = String(rows[0].foto_url).replace(/^\/+/, '');
                const filepath = path.join(__dirname, '..', 'public', relativeFoto);
                fs.unlink(filepath, () => {});
            }

            await pool.query('UPDATE tios_casais SET foto_url = ? WHERE id = ? AND tenant_id = ?', [fotoUrl, casalId, tenantId]);
            return res.json({ message: 'Foto salva com sucesso.', foto_url: fotoUrl });
        } catch (err) {
            console.error('Erro ao salvar foto do casal:', err);
            return res.status(500).json({ error: 'Erro ao salvar foto.' });
        }
    });
});

module.exports = router;
