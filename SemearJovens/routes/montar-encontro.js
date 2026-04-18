const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { getTenantId } = require('../lib/tenantIsolation');
const { buildYoungFamilyMap } = require('../lib/relacoesFamiliares');
const {
    ensureHistoricoEquipesSnapshots,
    ensureHistoricoEquipesYoungFkPreserved,
    ensureEjcEncontristasHistoricoTable
} = require('../lib/ejcHistorySnapshots');
const https = require('https');
let NodeGeocoder = null;
try {
    NodeGeocoder = require('node-geocoder');
} catch (_) {
    NodeGeocoder = null;
}

let hasPapelBaseColumnCache = null;
let hasSubfuncaoColumnCache = null;
let hasMontagemDataInicioColumnCache = null;
let hasMontagemDataFimColumnCache = null;
let hasMontagemDataTardeRevelacaoColumnCache = null;
let hasMontagemDataInicioReunioesColumnCache = null;
let hasMontagemDataFimReunioesColumnCache = null;
let hasMontagemDiaSemanaReunioesColumnCache = null;
let ensuredReunioesTables = false;
let montagemFormulariosGarantido = false;
let montagemEncontristasGarantido = false;
let montagemEncontristasDadosGarantido = false;
const hasColumnCache = new Map();
let geocoderInstance = null;

const REGRAS_EJC_PADRAO = Object.freeze({
    coordenador_tipo_casal: 'LIVRE',
    permite_tios_coordenadores: 1,
    idade_maxima_coordenador_jovem: null,
    permite_casal_amasiado_servir: 1,
    casal_amasiado_regra_equipe: 'INDIFERENTE',
    anos_casado_sem_ecc_pode_servir: null
});

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
    const key = `${tableName}.${columnName}`;
    if (hasColumnCache.has(key)) return hasColumnCache.get(key);
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
    `, [tableName, columnName]);
    const exists = !!(rows && rows[0] && rows[0].cnt > 0);
    hasColumnCache.set(key, exists);
    return exists;
}

async function ensureEquipeSexoLimitsColumns() {
    const [hasLimiteHomens, hasLimiteMulheres] = await Promise.all([
        hasColumn('equipes', 'limite_homens'),
        hasColumn('equipes', 'limite_mulheres')
    ]);
    if (!hasLimiteHomens) {
        try {
            await pool.query('ALTER TABLE equipes ADD COLUMN limite_homens INT NULL DEFAULT NULL');
        } catch (_) { }
        hasColumnCache.delete('equipes.limite_homens');
    }
    if (!hasLimiteMulheres) {
        try {
            await pool.query('ALTER TABLE equipes ADD COLUMN limite_mulheres INT NULL DEFAULT NULL');
        } catch (_) { }
        hasColumnCache.delete('equipes.limite_mulheres');
    }
    const hasLimiteCasaisTios = await hasColumn('equipes', 'limite_casais_tios');
    if (!hasLimiteCasaisTios) {
        try {
            await pool.query('ALTER TABLE equipes ADD COLUMN limite_casais_tios INT NULL DEFAULT NULL');
        } catch (_) { }
        hasColumnCache.delete('equipes.limite_casais_tios');
    }
}

function normalizarSexo(valor) {
    const sexo = String(valor || '').trim().toLowerCase();
    if (sexo === 'masculino') return 'masculino';
    if (sexo === 'feminino') return 'feminino';
    return '';
}

function contarSexosDoGrupo(grupo) {
    const totais = { total: 0, homens: 0, mulheres: 0 };
    for (const membro of (grupo || [])) {
        const item = membro && membro.item ? membro.item : {};
        const ehCasalTios = !!(item && item.eh_casal_tios);
        if (ehCasalTios) {
            totais.total += 2;
            totais.homens += 1;
            totais.mulheres += 1;
            continue;
        }
        totais.total += 1;
        const sexo = normalizarSexo(item ? item.sexo : null);
        if (sexo === 'masculino') totais.homens += 1;
        if (sexo === 'feminino') totais.mulheres += 1;
    }
    return totais;
}

function normalizarLimiteEquipe(valor) {
    if (valor === null || valor === undefined || valor === '') return null;
    const numero = Number(valor);
    return Number.isFinite(numero) ? numero : null;
}

function equipeComportaGrupo(equipe, ocupacaoAtual, grupoTotais) {
    const atual = ocupacaoAtual || { total: 0, homens: 0, mulheres: 0 };
    const grupo = grupoTotais || { total: 0, homens: 0, mulheres: 0 };
    const limiteHomens = normalizarLimiteEquipe(equipe && equipe.limite_homens);
    const limiteMulheres = normalizarLimiteEquipe(equipe && equipe.limite_mulheres);
    if (Number.isFinite(limiteHomens) && limiteHomens >= 0 && (atual.homens + grupo.homens) > limiteHomens) return false;
    if (Number.isFinite(limiteMulheres) && limiteMulheres >= 0 && (atual.mulheres + grupo.mulheres) > limiteMulheres) return false;
    return true;
}

async function ensureNaoServeEjcColumns() {
    const [hasFlag, hasMotivo] = await Promise.all([
        hasColumn('jovens', 'nao_serve_ejc'),
        hasColumn('jovens', 'motivo_nao_serve_ejc')
    ]);
    if (!hasFlag) {
        try {
            await pool.query("ALTER TABLE jovens ADD COLUMN nao_serve_ejc TINYINT(1) NOT NULL DEFAULT 0 AFTER observacoes_extras");
        } catch (e) { }
        hasColumnCache.delete('jovens.nao_serve_ejc');
    }
    if (!hasMotivo) {
        try {
            await pool.query("ALTER TABLE jovens ADD COLUMN motivo_nao_serve_ejc TEXT NULL AFTER nao_serve_ejc");
        } catch (e) { }
        hasColumnCache.delete('jovens.motivo_nao_serve_ejc');
    }
}

async function validarNumeroMontagemUnico({ tenantId, numero, montagemIdIgnorar = null }) {
    const numeroNormalizado = Number(numero);
    if (!Number.isInteger(numeroNormalizado) || numeroNormalizado <= 0) {
        return 'Número do EJC inválido.';
    }

    const paramsMontagem = [tenantId, numeroNormalizado];
    let sqlMontagem = 'SELECT id FROM montagens WHERE tenant_id = ? AND numero_ejc = ?';
    if (montagemIdIgnorar) {
        sqlMontagem += ' AND id <> ?';
        paramsMontagem.push(montagemIdIgnorar);
    }
    sqlMontagem += ' LIMIT 1';

    const [montagens] = await pool.query(sqlMontagem, paramsMontagem);
    if (montagens && montagens.length) {
        return 'Já existe uma montagem com esse número de EJC.';
    }

    if (await hasTable('ejc')) {
        const [ejcs] = await pool.query(
            `SELECT id
             FROM ejc
             WHERE tenant_id = ?
               AND numero = ?
             LIMIT 1`,
            [tenantId, numeroNormalizado]
        );
        if (ejcs && ejcs.length) {
            return 'Já existe um EJC com esse número.';
        }
    }

    return null;
}

function normalizarTelefoneDigits(valor) {
    return String(valor || '').replace(/\D/g, '');
}

function montarTelefoneCasal(telefoneTio, telefoneTia) {
    const itens = [telefoneTio, telefoneTia]
        .map((telefone) => String(telefone || '').trim())
        .filter(Boolean);
    return itens.length ? Array.from(new Set(itens)).join(' / ') : null;
}

function normalizarTextoCasal(valor) {
    return String(valor || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function montarChaveCasalMesmoEjc(jovemId, conjugeId) {
    const a = Number(jovemId) || 0;
    const b = Number(conjugeId) || 0;
    if (a <= 0 || b <= 0) return '';
    return `casal:jovens:${Math.min(a, b)}-${Math.max(a, b)}`;
}

function montarChaveCasalOutroEjc(outroEjcId, nomeConjuge) {
    const outroId = Number(outroEjcId) || 0;
    const nome = normalizarTextoCasal(nomeConjuge);
    if (outroId <= 0 || !nome) return '';
    return `casal:outro-ejc:${outroId}:${nome}`;
}

function obterChaveItemOutroEjc(item) {
    if (!item) return '';
    const jovemId = Number(item.jovem_id || item.id || 0);
    if (jovemId > 0) return `jovem:${jovemId}`;
    const nome = normalizarTextoCasal(item.nome_externo || item.nome_completo || item.nome);
    const telefone = normalizarTelefoneDigits(item.telefone_externo || item.telefone);
    if (!nome) return '';
    return `externo:${nome}|${telefone}`;
}

function obterChaveCasalJovem(item) {
    if (!item) return '';
    const jovemId = Number(item.id || item.jovem_id || 0);
    const conjugeId = Number(item.conjuge_id || 0);
    if (jovemId > 0 && conjugeId > 0) {
        return montarChaveCasalMesmoEjc(jovemId, conjugeId);
    }
    return montarChaveCasalOutroEjc(item.conjuge_outro_ejc_id, item.conjuge_nome);
}

function obterChaveCasalOutroItem(item) {
    if (!item) return '';
    const jovemId = Number(item.jovem_id || 0);
    const conjugeId = Number(item.conjuge_id || 0);
    if (jovemId > 0 && conjugeId > 0) {
        return montarChaveCasalMesmoEjc(jovemId, conjugeId);
    }
    return montarChaveCasalOutroEjc(item.outro_ejc_id, item.nome_externo || item.nome_completo || item.nome);
}

function adicionarHistoricoNoMapa(mapa, jovemId, equipeNome) {
    const id = Number(jovemId) || 0;
    const equipe = String(equipeNome || '').trim().toLowerCase();
    if (id <= 0 || !equipe) return;
    if (!mapa.has(id)) mapa.set(id, new Set());
    mapa.get(id).add(equipe);
}

function parseJsonSafe(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(String(value));
    } catch (_) {
        return fallback;
    }
}

async function garantirMontagemFormularios() {
    if (montagemFormulariosGarantido) return;
    if (await hasTable('montagem_formularios')) {
        montagemFormulariosGarantido = true;
        return;
    }
    await pool.query(`
        CREATE TABLE IF NOT EXISTS montagem_formularios (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            montagem_id INT NOT NULL,
            formulario_id INT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_montagem_form (montagem_id, formulario_id),
            KEY idx_montagem_form_tenant (tenant_id),
            CONSTRAINT fk_montagem_form_montagem FOREIGN KEY (montagem_id) REFERENCES montagens(id) ON DELETE CASCADE,
            CONSTRAINT fk_montagem_form_form FOREIGN KEY (formulario_id) REFERENCES formularios_itens(id) ON DELETE CASCADE
        )
    `);
    montagemFormulariosGarantido = true;
}

async function garantirMontagemEncontristas() {
    if (montagemEncontristasGarantido) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS montagem_encontristas (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            montagem_id INT NOT NULL,
            resposta_id INT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_montagem_encontrista (montagem_id, resposta_id),
            KEY idx_montagem_encontrista_tenant (tenant_id),
            CONSTRAINT fk_montagem_encontrista_montagem FOREIGN KEY (montagem_id) REFERENCES montagens(id) ON DELETE CASCADE
        )
    `);
    montagemEncontristasGarantido = true;
}

async function garantirMontagemEncontristasDados() {
    if (montagemEncontristasDadosGarantido) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS montagem_encontristas_dados (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            montagem_id INT NOT NULL,
            resposta_id INT NOT NULL,
            nome_referencia VARCHAR(180) NULL,
            telefone_referencia VARCHAR(30) NULL,
            circulo VARCHAR(80) NULL,
            cep VARCHAR(12) NULL,
            endereco VARCHAR(220) NULL,
            numero VARCHAR(20) NULL,
            bairro VARCHAR(120) NULL,
            cidade VARCHAR(120) NULL,
            complemento VARCHAR(120) NULL,
            latitude DECIMAL(10,7) NULL,
            longitude DECIMAL(10,7) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_montagem_encontrista_dados (tenant_id, montagem_id, resposta_id),
            KEY idx_montagem_encontrista_dados_montagem (montagem_id),
            CONSTRAINT fk_montagem_encontrista_dados_montagem FOREIGN KEY (montagem_id) REFERENCES montagens(id) ON DELETE CASCADE
        )
    `);
    montagemEncontristasDadosGarantido = true;
}

function criarEncontristaListaMestre(row) {
    const jovemId = Number(row && row.jovem_id);
    return {
        id: jovemId > 0 ? -jovemId : null,
        jovem_id: jovemId > 0 ? jovemId : null,
        formulario_id: null,
        nome_referencia: row.nome_referencia || row.nome_completo || '',
        telefone_referencia: row.telefone_referencia || row.telefone || '',
        resposta_json: null,
        registrado_em: row.registrado_em || row.created_at || null,
        formulario_titulo: 'Lista Mestre',
        selecionado_em: row.selecionado_em || row.created_at || null,
        vinculado_lista_mestre: true,
        resposta: {
            origem: 'lista_mestre',
            jovem_id: jovemId > 0 ? jovemId : null
        }
    };
}

function mapearPapelPorNomeFuncao(nomeFuncao) {
    const funcaoLower = (nomeFuncao || '').toLowerCase();
    if (funcaoLower.includes('tio') || funcaoLower.includes('tia')) return 'Tio';
    if (
        funcaoLower.includes('coordenador') ||
        funcaoLower.includes('cordenador') ||
        funcaoLower.includes('coord')
    ) return 'Coordenador';
    return 'Membro';
}

function montarEtiquetaEdicao(numeroEjc) {
    return `${numeroEjc}º EJC (Montagem)`;
}

function normalizarDestinoSelecao(valor) {
    return String(valor || '').trim().toLowerCase() === 'reserva' ? 'reserva' : 'titular';
}

function normalizarDataISO(valor) {
    if (!valor) return null;
    const str = String(valor);
    return str.includes('T') ? str.split('T')[0] : str;
}

function normalizarDataBr(valor) {
    if (!valor) return null;
    const txt = String(valor).trim();
    if (!txt) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(txt)) return txt;
    const m = txt.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    return null;
}

function normalizarDataEntrada(valor) {
    return normalizarDataBr(valor) || normalizarDataISO(valor);
}

function formatarDataBrLocal(valor) {
    const iso = normalizarDataEntrada(valor);
    if (!iso) return '-';
    const partes = iso.split('-');
    if (partes.length !== 3) return iso;
    return `${partes[2]}/${partes[1]}/${partes[0]}`;
}

function calcularIdadeNaData(dataNascimento, dataReferencia) {
    const nasc = normalizarDataEntrada(dataNascimento);
    const ref = normalizarDataEntrada(dataReferencia);
    if (!nasc || !ref) return null;
    const [na, nm, nd] = nasc.split('-').map(Number);
    const [ra, rm, rd] = ref.split('-').map(Number);
    if (![na, nm, nd, ra, rm, rd].every(Number.isFinite)) return null;
    let idade = ra - na;
    if (rm < nm || (rm === nm && rd < nd)) idade -= 1;
    return idade >= 0 ? idade : null;
}

function adicionarAnosNaDataIso(dataIso, anos) {
    const base = normalizarDataEntrada(dataIso);
    const totalAnos = Number(anos);
    if (!base || !Number.isFinite(totalAnos)) return null;
    const [ano, mes, dia] = base.split('-').map(Number);
    if (![ano, mes, dia].every(Number.isFinite)) return null;
    const dt = new Date(Date.UTC(ano + totalAnos, mes - 1, dia));
    const anoFinal = dt.getUTCFullYear();
    const mesFinal = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const diaFinal = String(dt.getUTCDate()).padStart(2, '0');
    return `${anoFinal}-${mesFinal}-${diaFinal}`;
}

function ehFuncaoCoordenador(nomeFuncao, papelBase) {
    const nome = String(nomeFuncao || '').trim().toLowerCase();
    const papel = String(papelBase || '').trim().toLowerCase();
    return (
        papel === 'coordenador' ||
        papel === 'cordenador' ||
        nome.includes('coordenador') ||
        nome.includes('cordenador') ||
        nome.includes('coord')
    );
}

function extrairTiposRestricaoAlimentar(detalhes) {
    const texto = String(detalhes || '').trim();
    if (!texto) return ['Restrição alimentar não informada'];
    const partes = texto
        .split(/[\n,;|]+/g)
        .map((item) => String(item || '').trim())
        .filter(Boolean);
    return partes.length ? Array.from(new Set(partes)) : ['Restrição alimentar não informada'];
}

function normalizarChaveResposta(valor) {
    return String(valor || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

function extrairDetalhesRestricaoEncontrista(resposta) {
    const base = resposta && typeof resposta === 'object' ? resposta : {};
    const candidatos = [base];
    if (base.campos && typeof base.campos === 'object' && !Array.isArray(base.campos)) candidatos.push(base.campos);

    const chavesAceitas = new Set([
        'restricaoalimentar',
        'restricaoalimentarqual',
        'possuirestricaoalimentarqual',
        'hasfoodrestriction'
    ]);

    for (const fonte of candidatos) {
        for (const [chave, valor] of Object.entries(fonte)) {
            const chaveNorm = normalizarChaveResposta(chave);
            if (!chavesAceitas.has(chaveNorm)) continue;
            const texto = String(valor || '').trim();
            if (texto) return texto;
        }
    }

    const campos = Array.isArray(base.campos) ? base.campos : [];
    for (const campo of campos) {
        if (!campo || typeof campo !== 'object') continue;
        const chaveId = normalizarChaveResposta(campo.id);
        const chaveLabel = normalizarChaveResposta(campo.label);
        if (!chavesAceitas.has(chaveId) && !chavesAceitas.has(chaveLabel)) continue;
        const valor = Array.isArray(campo.valor)
            ? campo.valor.map((item) => String(item || '').trim()).filter(Boolean).join(', ')
            : String(campo.valor || '').trim();
        if (valor) return valor;
    }
    return '';
}

function equipesBloqueadasPorFamilia(grupo, mapaFamilia, alocadoEquipePorJovemId) {
    const bloqueadas = new Set();
    for (const membro of (grupo || [])) {
        const item = membro && membro.item ? membro.item : null;
        const jovemId = Number(item && (item.id || item.jovem_id) || 0);
        if (!jovemId) continue;
        const relacionados = mapaFamilia.get(jovemId) || new Set();
        for (const relacionadoId of relacionados) {
            const equipeId = alocadoEquipePorJovemId.get(Number(relacionadoId) || 0);
            if (equipeId) bloqueadas.add(Number(equipeId));
        }
    }
    return bloqueadas;
}

function criarBucketRestricao(tipo) {
    return {
        tipo,
        total: 0,
        encontreirosTotal: 0,
        encontristasTotal: 0,
        encontreiros: [],
        encontristas: []
    };
}

async function garantirEstruturaMontagemReunioes() {
    if (ensuredReunioesTables) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS montagem_reunioes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            montagem_id INT NOT NULL,
            data_reuniao DATE NOT NULL,
            periodo VARCHAR(120) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_montagem_reuniao (montagem_id, data_reuniao),
            CONSTRAINT fk_montagem_reunioes_montagem FOREIGN KEY (montagem_id) REFERENCES montagens(id) ON DELETE CASCADE
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS montagem_reunioes_presencas (
            id INT AUTO_INCREMENT PRIMARY KEY,
            montagem_id INT NOT NULL,
            reuniao_id INT NOT NULL,
            jovem_id INT NULL,
            membro_id INT NULL,
            presente TINYINT(1) NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_reuniao_jovem (reuniao_id, jovem_id),
            UNIQUE KEY uniq_reuniao_membro (reuniao_id, membro_id),
            KEY idx_montagem_jovem (montagem_id, jovem_id),
            KEY idx_montagem_membro (montagem_id, membro_id),
            CONSTRAINT fk_reuniao_presenca_reuniao FOREIGN KEY (reuniao_id) REFERENCES montagem_reunioes(id) ON DELETE CASCADE
        )
    `);
    await runAlterIgnoreDuplicate("ALTER TABLE montagem_reunioes_presencas ADD COLUMN membro_id INT NULL AFTER jovem_id");
    await runAlterIgnoreDuplicate("ALTER TABLE montagem_reunioes_presencas ADD UNIQUE KEY uniq_reuniao_membro (reuniao_id, membro_id)");
    await runAlterIgnoreDuplicate("ALTER TABLE montagem_reunioes_presencas ADD KEY idx_montagem_membro (montagem_id, membro_id)");
    try {
        await pool.query("ALTER TABLE montagem_reunioes_presencas MODIFY COLUMN jovem_id INT NULL");
    } catch (_) { }
    try {
        await pool.query(`
            UPDATE montagem_reunioes_presencas mrp
            JOIN montagem_membros mm
              ON mm.montagem_id = mrp.montagem_id
             AND mm.jovem_id = mrp.jovem_id
             AND mm.eh_substituicao = 0
            SET mrp.membro_id = mm.id
            WHERE mrp.membro_id IS NULL
              AND mrp.jovem_id IS NOT NULL
        `);
    } catch (_) { }
    ensuredReunioesTables = true;
}

async function runAlterIgnoreDuplicate(sql) {
    try {
        await pool.query(sql);
    } catch (err) {
        if (err && (err.code === 'ER_DUP_FIELDNAME' || err.code === 'ER_DUP_KEYNAME')) return;
        throw err;
    }
}

async function garantirEstruturaEjcDatasMontagem() {
    await runAlterIgnoreDuplicate("ALTER TABLE ejc ADD COLUMN data_encontro DATE NULL AFTER data_fim");
    await runAlterIgnoreDuplicate("ALTER TABLE ejc ADD COLUMN data_tarde_revelacao DATE NULL AFTER data_encontro");
    await runAlterIgnoreDuplicate("ALTER TABLE ejc ADD COLUMN data_inicio_reunioes DATE NULL AFTER data_tarde_revelacao");
    await runAlterIgnoreDuplicate("ALTER TABLE ejc ADD COLUMN data_fim_reunioes DATE NULL AFTER data_inicio_reunioes");
    await runAlterIgnoreDuplicate("ALTER TABLE ejc ADD COLUMN dia_semana_reunioes TINYINT NULL AFTER data_fim_reunioes");
}

async function garantirEstruturaRegrasEjc() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ejc_regras (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            ejc_id INT NOT NULL,
            coordenador_tipo_casal VARCHAR(40) NOT NULL DEFAULT 'LIVRE',
            permite_tios_coordenadores TINYINT(1) NOT NULL DEFAULT 1,
            idade_maxima_coordenador_jovem INT NULL DEFAULT NULL,
            permite_casal_amasiado_servir TINYINT(1) NOT NULL DEFAULT 1,
            casal_amasiado_regra_equipe VARCHAR(40) NOT NULL DEFAULT 'INDIFERENTE',
            anos_casado_sem_ecc_pode_servir INT NULL DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_ejc_regras_tenant (tenant_id, ejc_id),
            KEY idx_ejc_regras_ejc (ejc_id),
            CONSTRAINT fk_ejc_regras_ejc FOREIGN KEY (ejc_id) REFERENCES ejc(id) ON DELETE CASCADE
        )
    `);
}

async function garantirRegrasPadraoParaEjc(tenantId, ejcId) {
    await garantirEstruturaRegrasEjc();
    await pool.query(
        `INSERT IGNORE INTO ejc_regras (
            tenant_id, ejc_id, coordenador_tipo_casal, permite_tios_coordenadores,
            idade_maxima_coordenador_jovem, permite_casal_amasiado_servir,
            casal_amasiado_regra_equipe, anos_casado_sem_ecc_pode_servir
        ) VALUES (?, ?, 'LIVRE', 1, NULL, 1, 'INDIFERENTE', NULL)`,
        [tenantId, ejcId]
    );
}

async function sincronizarEdicaoERegrasDaMontagem({
    tenantId,
    numeroEjc,
    dataInicio,
    dataFim,
    dataEncontro,
    dataTardeRevelacao,
    dataInicioReunioes,
    dataFimReunioes,
    diaSemanaReunioes
}) {
    await garantirEstruturaEjcDatasMontagem();
    await garantirEstruturaRegrasEjc();

    const [[tenantRow]] = await pool.query(
        'SELECT paroquia FROM tenants_ejc WHERE id = ? LIMIT 1',
        [tenantId]
    );
    const paroquia = tenantRow && tenantRow.paroquia ? tenantRow.paroquia : null;
    const anoBase = (dataInicio || dataEncontro)
        ? Number(String(dataInicio || dataEncontro).slice(0, 4))
        : new Date().getFullYear();

    const [[ejcExistente]] = await pool.query(
        'SELECT id FROM ejc WHERE tenant_id = ? AND numero = ? LIMIT 1',
        [tenantId, Number(numeroEjc)]
    );

    let ejcId = ejcExistente && ejcExistente.id ? Number(ejcExistente.id) : 0;
    if (ejcId > 0) {
        await pool.query(
            `UPDATE ejc
             SET paroquia = COALESCE(?, paroquia),
                 ano = ?,
                 data_inicio = ?,
                 data_fim = ?,
                 data_encontro = ?,
                 data_tarde_revelacao = ?,
                 data_inicio_reunioes = ?,
                 data_fim_reunioes = ?,
                 dia_semana_reunioes = ?
             WHERE id = ? AND tenant_id = ?`,
            [
                paroquia,
                Number.isFinite(anoBase) ? anoBase : new Date().getFullYear(),
                dataInicio || null,
                dataFim || null,
                dataEncontro || null,
                dataTardeRevelacao || null,
                dataInicioReunioes || null,
                dataFimReunioes || null,
                normalizarDiaSemana(diaSemanaReunioes),
                ejcId,
                tenantId
            ]
        );
    } else {
        const [insertEjc] = await pool.query(
            `INSERT INTO ejc (
                tenant_id, numero, paroquia, ano, data_inicio, data_fim,
                data_encontro, data_tarde_revelacao, data_inicio_reunioes,
                data_fim_reunioes, dia_semana_reunioes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                tenantId,
                Number(numeroEjc),
                paroquia,
                Number.isFinite(anoBase) ? anoBase : new Date().getFullYear(),
                dataInicio || null,
                dataFim || null,
                dataEncontro || null,
                dataTardeRevelacao || null,
                dataInicioReunioes || null,
                dataFimReunioes || null,
                normalizarDiaSemana(diaSemanaReunioes)
            ]
        );
        ejcId = Number(insertEjc.insertId);
        await pool.query(
            `INSERT IGNORE INTO equipes_ejc (tenant_id, ejc_id, equipe_id)
             SELECT ?, ?, id FROM equipes WHERE tenant_id = ?`,
            [tenantId, ejcId, tenantId]
        );
    }

    if (ejcId > 0) {
        await garantirRegrasPadraoParaEjc(tenantId, ejcId);
    }

    return ejcId;
}

function normalizarDiaSemana(valor) {
    const numero = Number(valor);
    if (!Number.isInteger(numero) || numero < 0 || numero > 6) return null;
    return numero;
}

function gerarDatasReunioesPorDiaSemana(dataInicio, dataFim, diaSemana) {
    if (!dataInicio || !dataFim) return [];
    const dia = normalizarDiaSemana(diaSemana);
    if (dia === null) return [];
    const start = new Date(`${dataInicio}T00:00:00`);
    const end = new Date(`${dataFim}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];

    const datas = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        if (d.getDay() === dia) {
            datas.push(d.toISOString().split('T')[0]);
        }
    }
    return datas;
}

async function recriarReunioesDaMontagem({ montagemId, dataInicio, dataFim, diaSemana, periodo = null }) {
    await garantirEstruturaMontagemReunioes();
    const datas = gerarDatasReunioesPorDiaSemana(dataInicio, dataFim, diaSemana);
    await pool.query('DELETE FROM montagem_reunioes_presencas WHERE montagem_id = ?', [montagemId]);
    await pool.query('DELETE FROM montagem_reunioes WHERE montagem_id = ?', [montagemId]);
    if (!datas.length) return { total: 0 };

    const values = datas.map((d) => [montagemId, d, periodo]);
    await pool.query(
        'INSERT INTO montagem_reunioes (montagem_id, data_reuniao, periodo) VALUES ?',
        [values]
    );
    return { total: datas.length };
}

async function sincronizarHistoricoDaAlocacao({ montagemId, equipeId, funcaoId, jovemId, tenantId }) {
    const comPapelBase = await hasPapelBaseColumn();
    const papelBaseSelect = comPapelBase
        ? 'COALESCE(ef.papel_base, "Membro")'
        : '"Membro"';
    const [[dadosAux]] = await pool.query(`
        SELECT m.numero_ejc, e.nome as equipe_nome, ef.nome as funcao_nome, ${papelBaseSelect} as papel_base
        FROM montagens m
        JOIN equipes e ON e.id = ?
        JOIN equipes_funcoes ef ON ef.id = ?
        WHERE m.id = ?
    `, [equipeId, funcaoId, montagemId]);

    if (!dadosAux) return false;

    const papelMapeado = dadosAux.papel_base || mapearPapelPorNomeFuncao(dadosAux.funcao_nome);
    const subfuncao = dadosAux.funcao_nome || null;
    const edicaoMontagem = montarEtiquetaEdicao(dadosAux.numero_ejc);
    const comSubfuncao = await hasSubfuncaoColumn();

    if (comSubfuncao) {
        const [histExists] = await pool.query(
            `SELECT id
             FROM historico_equipes
             WHERE jovem_id = ?
               AND tenant_id = ?
               AND equipe = ?
               AND papel = ?
               AND (subfuncao <=> ?)
               AND (edicao_ejc <=> ?)`,
            [jovemId, tenantId, dadosAux.equipe_nome, papelMapeado, subfuncao, edicaoMontagem]
        );
        if (histExists.length === 0) {
            await pool.query(
                `INSERT INTO historico_equipes (tenant_id, jovem_id, edicao_ejc, equipe, papel, subfuncao, ejc_id) 
                 VALUES (?, ?, ?, ?, ?, ?, NULL)`,
                [tenantId, jovemId, edicaoMontagem, dadosAux.equipe_nome, papelMapeado, subfuncao]
            );
        }
    } else {
        const [histExists] = await pool.query(
            `SELECT id
             FROM historico_equipes
             WHERE jovem_id = ?
               AND tenant_id = ?
               AND equipe = ?
               AND papel = ?
               AND (edicao_ejc <=> ?)`,
            [jovemId, tenantId, dadosAux.equipe_nome, papelMapeado, edicaoMontagem]
        );
        if (histExists.length === 0) {
            await pool.query(
                `INSERT INTO historico_equipes (tenant_id, jovem_id, edicao_ejc, equipe, papel, ejc_id) 
                 VALUES (?, ?, ?, ?, ?, NULL)`,
                [tenantId, jovemId, edicaoMontagem, dadosAux.equipe_nome, papelMapeado]
            );
        }
    }

    return true;
}

async function removerHistoricoDaAlocacao({ montagemId, equipeId, funcaoId, jovemId, tenantId }) {
    const comPapelBase = await hasPapelBaseColumn();
    const papelBaseSelect = comPapelBase
        ? 'COALESCE(ef.papel_base, "Membro")'
        : '"Membro"';
    const [[dadosAux]] = await pool.query(`
        SELECT m.numero_ejc, e.nome as equipe_nome, ef.nome as funcao_nome, ${papelBaseSelect} as papel_base
        FROM montagens m
        JOIN equipes e ON e.id = ?
        JOIN equipes_funcoes ef ON ef.id = ?
        WHERE m.id = ?
    `, [equipeId, funcaoId, montagemId]);

    if (!dadosAux || !jovemId) return false;

    const papelMapeado = dadosAux.papel_base || mapearPapelPorNomeFuncao(dadosAux.funcao_nome);
    const subfuncao = dadosAux.funcao_nome || null;
    const edicaoMontagem = montarEtiquetaEdicao(dadosAux.numero_ejc);
    const comSubfuncao = await hasSubfuncaoColumn();

    if (comSubfuncao) {
        await pool.query(
            `DELETE FROM historico_equipes
             WHERE jovem_id = ?
               AND tenant_id = ?
               AND equipe = ?
               AND papel = ?
               AND (subfuncao <=> ?)
               AND (edicao_ejc <=> ?)
             ORDER BY id DESC
             LIMIT 1`,
            [jovemId, tenantId, dadosAux.equipe_nome, papelMapeado, subfuncao, edicaoMontagem]
        );
    } else {
        await pool.query(
            `DELETE FROM historico_equipes
             WHERE jovem_id = ?
               AND tenant_id = ?
               AND equipe = ?
               AND papel = ?
               AND (edicao_ejc <=> ?)
             ORDER BY id DESC
             LIMIT 1`,
            [jovemId, tenantId, dadosAux.equipe_nome, papelMapeado, edicaoMontagem]
        );
    }

    return true;
}

async function hasPapelBaseColumn() {
    if (hasPapelBaseColumnCache !== null) return hasPapelBaseColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'equipes_funcoes'
          AND COLUMN_NAME = 'papel_base'
    `);
    hasPapelBaseColumnCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasPapelBaseColumnCache;
}

async function hasSubfuncaoColumn() {
    if (hasSubfuncaoColumnCache !== null) return hasSubfuncaoColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'historico_equipes'
          AND COLUMN_NAME = 'subfuncao'
    `);
    hasSubfuncaoColumnCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasSubfuncaoColumnCache;
}

async function hasMontagemDataInicioColumn() {
    if (hasMontagemDataInicioColumnCache !== null) return hasMontagemDataInicioColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'montagens'
          AND COLUMN_NAME = 'data_inicio'
    `);
    hasMontagemDataInicioColumnCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasMontagemDataInicioColumnCache;
}

async function hasMontagemDataFimColumn() {
    if (hasMontagemDataFimColumnCache !== null) return hasMontagemDataFimColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'montagens'
          AND COLUMN_NAME = 'data_fim'
    `);
    hasMontagemDataFimColumnCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasMontagemDataFimColumnCache;
}

async function hasMontagemDataTardeRevelacaoColumn() {
    if (hasMontagemDataTardeRevelacaoColumnCache !== null) return hasMontagemDataTardeRevelacaoColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'montagens'
          AND COLUMN_NAME = 'data_tarde_revelacao'
    `);
    hasMontagemDataTardeRevelacaoColumnCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasMontagemDataTardeRevelacaoColumnCache;
}

async function hasMontagemDataInicioReunioesColumn() {
    if (hasMontagemDataInicioReunioesColumnCache !== null) return hasMontagemDataInicioReunioesColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'montagens'
          AND COLUMN_NAME = 'data_inicio_reunioes'
    `);
    hasMontagemDataInicioReunioesColumnCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasMontagemDataInicioReunioesColumnCache;
}

async function hasMontagemDataFimReunioesColumn() {
    if (hasMontagemDataFimReunioesColumnCache !== null) return hasMontagemDataFimReunioesColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'montagens'
          AND COLUMN_NAME = 'data_fim_reunioes'
    `);
    hasMontagemDataFimReunioesColumnCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasMontagemDataFimReunioesColumnCache;
}

async function hasMontagemDiaSemanaReunioesColumn() {
    if (hasMontagemDiaSemanaReunioesColumnCache !== null) return hasMontagemDiaSemanaReunioesColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'montagens'
          AND COLUMN_NAME = 'dia_semana_reunioes'
    `);
    hasMontagemDiaSemanaReunioesColumnCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasMontagemDiaSemanaReunioesColumnCache;
}

async function garantirEstruturaMontagemMembrosExtra() {
    await runAlterIgnoreDuplicate("ALTER TABLE montagem_membros ADD COLUMN status_ligacao ENUM('ACEITOU','RECUSOU','LIGAR_MAIS_TARDE','TELEFONE_INCORRETO') NULL AFTER jovem_id");
    await runAlterIgnoreDuplicate("ALTER TABLE montagem_membros ADD COLUMN motivo_recusa TEXT NULL AFTER status_ligacao");
    await runAlterIgnoreDuplicate("ALTER TABLE montagem_membros ADD COLUMN eh_substituicao TINYINT(1) NOT NULL DEFAULT 0 AFTER motivo_recusa");
    await runAlterIgnoreDuplicate("ALTER TABLE montagem_membros ADD COLUMN nome_externo VARCHAR(180) NULL AFTER eh_substituicao");
    await runAlterIgnoreDuplicate("ALTER TABLE montagem_membros ADD COLUMN telefone_externo VARCHAR(30) NULL AFTER nome_externo");
    try {
        await pool.query("ALTER TABLE montagem_membros MODIFY jovem_id INT NULL");
    } catch (err) {
        if (!err || err.code !== 'ER_DUP_FIELDNAME') {
            if (err.code !== 'ER_PARSE_ERROR' && err.code !== 'ER_BAD_FIELD_ERROR') {
                throw err;
            }
        }
    }
    try {
        await pool.query("ALTER TABLE montagem_membros MODIFY status_ligacao ENUM('ACEITOU','RECUSOU','LIGAR_MAIS_TARDE','TELEFONE_INCORRETO') NULL");
    } catch (err) {
        if (!err || err.code !== 'ER_DUP_FIELDNAME') {
            if (err.code !== 'ER_PARSE_ERROR' && err.code !== 'ER_BAD_FIELD_ERROR') {
                throw err;
            }
        }
    }
}

async function garantirEstruturaMontagemDatas() {
    await runAlterIgnoreDuplicate("ALTER TABLE montagens ADD COLUMN data_tarde_revelacao DATE NULL AFTER data_encontro");
    await runAlterIgnoreDuplicate("ALTER TABLE montagens ADD COLUMN data_inicio_reunioes DATE NULL AFTER data_tarde_revelacao");
    await runAlterIgnoreDuplicate("ALTER TABLE montagens ADD COLUMN data_fim_reunioes DATE NULL AFTER data_inicio_reunioes");
    await runAlterIgnoreDuplicate("ALTER TABLE montagens ADD COLUMN dia_semana_reunioes TINYINT NULL AFTER data_fim_reunioes");
}

async function garantirEstruturaMontagemJovensServir() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS montagem_jovens_servir (
            id INT AUTO_INCREMENT PRIMARY KEY,
            montagem_id INT NOT NULL,
            jovem_id INT NOT NULL,
            pode_servir TINYINT(1) NOT NULL DEFAULT 1,
            destino ENUM('titular', 'reserva') NOT NULL DEFAULT 'titular',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_montagem_jovem_servir (montagem_id, jovem_id),
            CONSTRAINT fk_montagem_jovens_servir_montagem FOREIGN KEY (montagem_id) REFERENCES montagens(id) ON DELETE CASCADE,
            CONSTRAINT fk_montagem_jovens_servir_jovem FOREIGN KEY (jovem_id) REFERENCES jovens(id) ON DELETE CASCADE
        )
    `);
    await runAlterIgnoreDuplicate("ALTER TABLE montagem_jovens_servir ADD COLUMN destino ENUM('titular', 'reserva') NOT NULL DEFAULT 'titular' AFTER pode_servir");
}

async function garantirEstruturaMontagemTiosServir() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS montagem_tios_servir (
            id INT AUTO_INCREMENT PRIMARY KEY,
            montagem_id INT NOT NULL,
            casal_id INT NOT NULL,
            pode_servir TINYINT(1) NOT NULL DEFAULT 1,
            destino ENUM('titular', 'reserva') NOT NULL DEFAULT 'titular',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_montagem_tio_servir (montagem_id, casal_id),
            KEY idx_montagem_tios_servir_casal (casal_id),
            CONSTRAINT fk_montagem_tios_servir_montagem FOREIGN KEY (montagem_id) REFERENCES montagens(id) ON DELETE CASCADE
        )
    `);
    await runAlterIgnoreDuplicate("ALTER TABLE montagem_tios_servir ADD COLUMN destino ENUM('titular', 'reserva') NOT NULL DEFAULT 'titular' AFTER pode_servir");
}

async function garantirEstruturaMontagemOutroEjcServir() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS montagem_outro_ejc_servir (
            id INT AUTO_INCREMENT PRIMARY KEY,
            montagem_id INT NOT NULL,
            jovem_id INT NULL,
            nome_externo VARCHAR(180) NULL,
            telefone_externo VARCHAR(30) NULL,
            outro_ejc_id INT NULL,
            pode_servir TINYINT(1) NOT NULL DEFAULT 1,
            destino ENUM('titular', 'reserva') NOT NULL DEFAULT 'titular',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_montagem_outro_servir (montagem_id, jovem_id, nome_externo, telefone_externo),
            KEY idx_montagem_outro_jovem (jovem_id),
            CONSTRAINT fk_montagem_outro_servir_montagem FOREIGN KEY (montagem_id) REFERENCES montagens(id) ON DELETE CASCADE
        )
    `);
    await runAlterIgnoreDuplicate("ALTER TABLE montagem_outro_ejc_servir ADD COLUMN destino ENUM('titular', 'reserva') NOT NULL DEFAULT 'titular' AFTER pode_servir");
}

async function garantirEstruturaRegrasEjc() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ejc_regras (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            ejc_id INT NOT NULL,
            coordenador_tipo_casal VARCHAR(40) NOT NULL DEFAULT 'LIVRE',
            permite_tios_coordenadores TINYINT(1) NOT NULL DEFAULT 1,
            idade_maxima_coordenador_jovem INT NULL DEFAULT NULL,
            permite_casal_amasiado_servir TINYINT(1) NOT NULL DEFAULT 1,
            casal_amasiado_regra_equipe VARCHAR(40) NOT NULL DEFAULT 'INDIFERENTE',
            anos_casado_sem_ecc_pode_servir INT NULL DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_ejc_regras_tenant (tenant_id, ejc_id),
            KEY idx_ejc_regras_ejc (ejc_id),
            CONSTRAINT fk_ejc_regras_ejc FOREIGN KEY (ejc_id) REFERENCES ejc(id) ON DELETE CASCADE
        )
    `);
}

function mapearRegrasEjc(row) {
    return {
        ...REGRAS_EJC_PADRAO,
        ...(row || {}),
        coordenador_tipo_casal: row && row.coordenador_tipo_casal ? row.coordenador_tipo_casal : REGRAS_EJC_PADRAO.coordenador_tipo_casal,
        permite_tios_coordenadores: row && row.permite_tios_coordenadores !== null && row.permite_tios_coordenadores !== undefined
            ? (Number(row.permite_tios_coordenadores) === 1 ? 1 : 0)
            : REGRAS_EJC_PADRAO.permite_tios_coordenadores,
        idade_maxima_coordenador_jovem: row && row.idade_maxima_coordenador_jovem !== null ? Number(row.idade_maxima_coordenador_jovem) : null,
        permite_casal_amasiado_servir: row && row.permite_casal_amasiado_servir !== null && row.permite_casal_amasiado_servir !== undefined
            ? (Number(row.permite_casal_amasiado_servir) === 1 ? 1 : 0)
            : REGRAS_EJC_PADRAO.permite_casal_amasiado_servir,
        casal_amasiado_regra_equipe: row && row.casal_amasiado_regra_equipe ? row.casal_amasiado_regra_equipe : REGRAS_EJC_PADRAO.casal_amasiado_regra_equipe,
        anos_casado_sem_ecc_pode_servir: row && row.anos_casado_sem_ecc_pode_servir !== null ? Number(row.anos_casado_sem_ecc_pode_servir) : null
    };
}

async function obterContextoMontagemRegras(tenantId, montagemId) {
    await garantirEstruturaRegrasEjc();
    const [[row]] = await pool.query(`
        SELECT m.id AS montagem_id,
               m.numero_ejc,
               COALESCE(m.data_encontro, m.data_inicio, CURDATE()) AS data_referencia,
               e.id AS ejc_id,
               er.coordenador_tipo_casal,
               er.permite_tios_coordenadores,
               er.idade_maxima_coordenador_jovem,
               er.permite_casal_amasiado_servir,
               er.casal_amasiado_regra_equipe,
               er.anos_casado_sem_ecc_pode_servir
        FROM montagens m
        LEFT JOIN ejc e
          ON e.numero = m.numero_ejc
         AND e.tenant_id = m.tenant_id
        LEFT JOIN ejc_regras er
          ON er.ejc_id = e.id
         AND er.tenant_id = e.tenant_id
        WHERE m.id = ?
          AND m.tenant_id = ?
        LIMIT 1
    `, [montagemId, tenantId]);
    if (!row) return null;
    return {
        montagem_id: Number(row.montagem_id),
        ejc_id: row.ejc_id ? Number(row.ejc_id) : null,
        numero_ejc: row.numero_ejc ? Number(row.numero_ejc) : null,
        data_referencia: normalizarDataEntrada(row.data_referencia),
        regras: mapearRegrasEjc(row)
    };
}

async function obterFuncaoMontagem(tenantId, funcaoId) {
    const [[row]] = await pool.query(
        `SELECT id, nome, COALESCE(papel_base, 'Membro') AS papel_base
         FROM equipes_funcoes
         WHERE id = ? AND tenant_id = ?
         LIMIT 1`,
        [funcaoId, tenantId]
    );
    return row || null;
}

async function listarCoordenadoresDaEquipe(tenantId, montagemId, equipeId, membroIgnorarId = 0) {
    const [rows] = await pool.query(`
        SELECT mm.id AS membro_id,
               mm.equipe_id,
               mm.jovem_id,
               mm.nome_externo,
               j.sexo,
               COALESCE(ef.papel_base, 'Membro') AS papel_base,
               ef.nome AS funcao_nome
        FROM montagem_membros mm
        JOIN equipes_funcoes ef ON ef.id = mm.funcao_id
        LEFT JOIN jovens j ON j.id = mm.jovem_id
        WHERE mm.montagem_id = ?
          AND mm.equipe_id = ?
          AND mm.tenant_id = ?
          AND mm.eh_substituicao = 0
          AND mm.id <> ?
    `, [montagemId, equipeId, tenantId, Number(membroIgnorarId || 0)]);
    return rows.filter((row) => ehFuncaoCoordenador(row.funcao_nome, row.papel_base));
}

async function buscarAlocacoesDoCasalNaMontagem(tenantId, montagemId, casalKey, jovemIdAtual) {
    if (!casalKey) return [];
    const [rows] = await pool.query(`
        SELECT mm.id AS membro_id,
               mm.equipe_id,
               e.nome AS equipe_nome,
               j.id,
               j.conjuge_id,
               j.conjuge_outro_ejc_id,
               j.conjuge_nome
        FROM montagem_membros mm
        JOIN equipes e ON e.id = mm.equipe_id
        JOIN jovens j ON j.id = mm.jovem_id
        WHERE mm.montagem_id = ?
          AND mm.tenant_id = ?
          AND mm.jovem_id IS NOT NULL
          AND mm.eh_substituicao = 0
          AND mm.jovem_id <> ?
    `, [montagemId, tenantId, Number(jovemIdAtual || 0)]);
    return rows.filter((row) => obterChaveCasalJovem(row) === casalKey);
}

async function validarRegrasJovemNaMontagem({ tenantId, montagemId, equipeId, funcaoId, jovemId }) {
    const contexto = await obterContextoMontagemRegras(tenantId, montagemId);
    if (!contexto) return null;
    const funcao = await obterFuncaoMontagem(tenantId, funcaoId);
    if (!funcao) return null;

    const [[jovem]] = await pool.query(
        `SELECT id, nome_completo, sexo, data_nascimento, estado_civil, data_casamento,
                conjuge_id, conjuge_outro_ejc_id, conjuge_nome, conjuge_ecc_tipo
         FROM jovens
         WHERE id = ? AND tenant_id = ?
         LIMIT 1`,
        [jovemId, tenantId]
    );
    if (!jovem) return null;

    const regras = contexto.regras || REGRAS_EJC_PADRAO;
    const ehCoordenador = ehFuncaoCoordenador(funcao.nome, funcao.papel_base);
    if (ehCoordenador) {
        const limiteIdade = Number(regras.idade_maxima_coordenador_jovem);
        if (Number.isFinite(limiteIdade) && limiteIdade >= 0) {
            const idade = calcularIdadeNaData(jovem.data_nascimento, contexto.data_referencia);
            if (idade === null) {
                return {
                    status: 409,
                    error: `Não foi possível validar a idade de ${jovem.nome_completo}. Cadastre a data de nascimento para permitir coordenação.`
                };
            }
            if (idade > limiteIdade) {
                return {
                    status: 409,
                    error: `${jovem.nome_completo} tem ${idade} anos na data do encontro e ultrapassa o limite de ${limiteIdade} anos para coordenar. Edite as regras do ${contexto.numero_ejc}º EJC para permitir essa coordenação.`
                };
            }
        }

        if (String(regras.coordenador_tipo_casal || '').toUpperCase() === 'JOVEM_HOMEM_E_MULHER') {
            const sexo = normalizarSexo(jovem.sexo);
            if (!sexo) {
                return {
                    status: 409,
                    error: `Defina o sexo de ${jovem.nome_completo} para validar a regra de casal coordenador desta equipe.`
                };
            }
            const coordenadores = await listarCoordenadoresDaEquipe(tenantId, montagemId, equipeId);
            const existeMesmoSexo = coordenadores.some((item) => normalizarSexo(item.sexo) === sexo);
            if (existeMesmoSexo) {
                return {
                    status: 409,
                    error: sexo === 'masculino'
                        ? 'Esta equipe já possui um coordenador homem. Pela regra deste EJC, a coordenação precisa ser formada por 1 jovem homem e 1 jovem mulher.'
                        : 'Esta equipe já possui uma coordenadora mulher. Pela regra deste EJC, a coordenação precisa ser formada por 1 jovem homem e 1 jovem mulher.'
                };
            }
        }
    }

    if (String(jovem.estado_civil || '').trim() === 'Amasiado') {
        if (!regras.permite_casal_amasiado_servir) {
            return {
                status: 409,
                error: `${jovem.nome_completo} está marcado(a) como amasiado(a) e, pelas regras deste EJC, não pode servir no encontro.`
            };
        }

        const regraEquipe = String(regras.casal_amasiado_regra_equipe || 'INDIFERENTE').toUpperCase();
        const casalKey = obterChaveCasalJovem(jovem);
        if (casalKey && regraEquipe !== 'INDIFERENTE') {
            const alocacoesRelacionadas = await buscarAlocacoesDoCasalNaMontagem(tenantId, montagemId, casalKey, jovem.id);
            if (regraEquipe === 'MESMA_EQUIPE') {
                const emOutraEquipe = alocacoesRelacionadas.find((item) => Number(item.equipe_id) !== Number(equipeId));
                if (emOutraEquipe) {
                    return {
                        status: 409,
                        error: `${jovem.nome_completo} está em um casal amasiado que precisa servir na mesma equipe. O cônjuge já está alocado na equipe ${emOutraEquipe.equipe_nome}.`
                    };
                }
            }
            if (regraEquipe === 'EQUIPES_SEPARADAS') {
                const naMesmaEquipe = alocacoesRelacionadas.find((item) => Number(item.equipe_id) === Number(equipeId));
                if (naMesmaEquipe) {
                    return {
                        status: 409,
                        error: `${jovem.nome_completo} está em um casal amasiado que precisa servir em equipes separadas. O cônjuge já está nesta equipe.`
                    };
                }
            }
        }
    }

    const anosCasadoSemEcc = Number(regras.anos_casado_sem_ecc_pode_servir);
    if (
        String(jovem.estado_civil || '').trim() === 'Casado' &&
        String(jovem.conjuge_ecc_tipo || '').trim().toUpperCase() === 'NAO_FEZ' &&
        Number.isFinite(anosCasadoSemEcc) &&
        anosCasadoSemEcc >= 0
    ) {
        const dataCasamento = normalizarDataEntrada(jovem.data_casamento);
        if (!dataCasamento) {
            return {
                status: 409,
                error: `${jovem.nome_completo} está casado(a) com cônjuge sem ECC, mas não possui data de casamento cadastrada. Preencha essa data para validar a regra deste EJC.`
            };
        }
        const dataLimite = adicionarAnosNaDataIso(dataCasamento, anosCasadoSemEcc);
        if (dataLimite && contexto.data_referencia && contexto.data_referencia > dataLimite) {
            return {
                status: 409,
                error: `${jovem.nome_completo} só podia servir até ${formatarDataBrLocal(dataLimite)}, pois casou em ${formatarDataBrLocal(dataCasamento)} e a regra deste EJC permite apenas ${anosCasadoSemEcc} ano(s) para casados sem ECC.`
            };
        }
    }

    return null;
}

async function validarRegrasMembroExternoNaMontagem({ tenantId, montagemId, equipeId, funcaoId, origemTipo }) {
    const contexto = await obterContextoMontagemRegras(tenantId, montagemId);
    if (!contexto) return null;
    const funcao = await obterFuncaoMontagem(tenantId, funcaoId);
    if (!funcao) return null;

    const ehCoordenador = ehFuncaoCoordenador(funcao.nome, funcao.papel_base);
    const origem = String(origemTipo || '').trim().toUpperCase();
    if (origem === 'TIOS' && ehCoordenador && !contexto.regras.permite_tios_coordenadores) {
        return {
            status: 409,
            error: 'Pelas regras deste EJC, tios não podem coordenar equipes.'
        };
    }

    if (origem === 'TIOS') {
        const [[equipe]] = await pool.query(
            'SELECT id, nome, limite_casais_tios FROM equipes WHERE id = ? AND tenant_id = ? LIMIT 1',
            [equipeId, tenantId]
        );
        const limite = Number(equipe && equipe.limite_casais_tios);
        if (Number.isFinite(limite) && limite >= 0) {
            const [[ocupacao]] = await pool.query(
                `SELECT COUNT(*) AS total
                 FROM montagem_membros mm
                 LEFT JOIN tios_casais tc
                   ON tc.tenant_id = mm.tenant_id
                  AND TRIM(CONCAT(COALESCE(tc.nome_tio, ''), ' e ', COALESCE(tc.nome_tia, ''))) = TRIM(COALESCE(mm.nome_externo, ''))
                 WHERE mm.montagem_id = ?
                   AND mm.equipe_id = ?
                   AND mm.tenant_id = ?
                   AND tc.id IS NOT NULL`,
                [montagemId, equipeId, tenantId]
            );
            if (Number(ocupacao && ocupacao.total || 0) >= limite) {
                return {
                    status: 409,
                    error: `A equipe ${equipe && equipe.nome ? equipe.nome : ''} já atingiu o limite de ${limite} casal(is) de tios.`
                };
            }
        }
    }

    return null;
}

// Listar montagens de encontros
router.get('/', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        await garantirEstruturaMontagemMembrosExtra();
        await ensureEquipeSexoLimitsColumns();
        await garantirEstruturaMontagemDatas();
        const comDataInicio = await hasMontagemDataInicioColumn();
        const comDataFim = await hasMontagemDataFimColumn();
        const comDataTarde = await hasMontagemDataTardeRevelacaoColumn();
        const comDataInicioReunioes = await hasMontagemDataInicioReunioesColumn();
        const comDataFimReunioes = await hasMontagemDataFimReunioesColumn();
        const comDiaSemanaReunioes = await hasMontagemDiaSemanaReunioesColumn();

        const selectDataInicio = comDataInicio ? 'data_inicio' : 'data_encontro';
        const selectDataFim = comDataFim ? 'data_fim' : 'data_encontro';
        const selectDataTarde = comDataTarde ? 'data_tarde_revelacao' : 'NULL';
        const selectDataInicioReunioes = comDataInicioReunioes ? 'data_inicio_reunioes' : 'NULL';
        const selectDataFimReunioes = comDataFimReunioes ? 'data_fim_reunioes' : 'NULL';
        const selectDiaSemanaReunioes = comDiaSemanaReunioes ? 'dia_semana_reunioes' : '0';
        const [rows] = await pool.query(`
            SELECT
                id,
                numero_ejc,
                data_encontro,
                ${selectDataTarde} AS data_tarde_revelacao,
                ${selectDataInicioReunioes} AS data_inicio_reunioes,
                ${selectDataFimReunioes} AS data_fim_reunioes,
                ${selectDiaSemanaReunioes} AS dia_semana_reunioes,
                ${selectDataInicio} AS data_inicio,
                ${selectDataFim} AS data_fim,
                CASE
                    WHEN COALESCE(${selectDataFimReunioes}, ${selectDataFim}, data_encontro) < CURDATE() THEN 1
                    ELSE 0
                END AS encerrada,
                created_at
            FROM montagens
            WHERE tenant_id = ?
            ORDER BY encerrada ASC, created_at DESC
        `, [tenantId]);
        res.json(rows);
    } catch (err) {
        console.error("Erro ao buscar montagens:", err);
        res.status(500).json({ error: "Erro ao buscar montagens" });
    }
});

// Proxy simples de tiles para evitar bloqueios no navegador (CSP/adblock/rede).
router.get('/tiles/osm/:z/:x/:y.png', async (req, res) => {
    try {
        const z = Number(req.params.z);
        const x = Number(req.params.x);
        const y = Number(req.params.y);
        if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || z < 0 || z > 19 || x < 0 || y < 0) {
            return res.status(400).send('Parâmetros de tile inválidos.');
        }

        const host = ['a', 'b', 'c'][(x + y) % 3];
        const urls = [
            `https://${host}.tile.openstreetmap.org/${z}/${x}/${y}.png`,
            `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
            `https://a.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`,
            `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`
        ];

        let finalizado = false;
        const tryUrl = (idx) => {
            if (finalizado || res.headersSent) return;
            if (idx >= urls.length) {
                finalizado = true;
                if (!res.headersSent) return res.status(502).end();
                return;
            }
            const upstream = https.get(urls[idx], {
                headers: {
                    'User-Agent': 'SemearJovens/1.0 (tile-proxy)',
                    'Accept': 'image/png,image/*;q=0.9,*/*;q=0.1'
                }
            }, (resp) => {
                const status = Number(resp.statusCode || 502);
                if (status !== 200) {
                    resp.resume();
                    return tryUrl(idx + 1);
                }
                finalizado = true;
                res.setHeader('Content-Type', String(resp.headers['content-type'] || 'image/png'));
                res.setHeader('Cache-Control', 'public, max-age=86400');
                resp.pipe(res);
            });

            upstream.on('error', () => {
                tryUrl(idx + 1);
            });
            upstream.setTimeout(8000, () => {
                try { upstream.destroy(); } catch (_) { }
                tryUrl(idx + 1);
            });
        };

        tryUrl(0);
    } catch (_) {
        if (!res.headersSent) return res.status(500).end();
    }
});

// Encontristas (respostas de inscrições vinculadas)
router.get('/:id/encontristas', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const montagemId = Number(req.params.id);
        if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
        await garantirMontagemFormularios();
        const hasForms = await hasTable('formularios_itens');
        const hasRespostas = await hasTable('formularios_respostas');
        if (!hasForms || !hasRespostas) return res.json([]);

        const [rows] = await pool.query(
            `SELECT fr.id, fr.formulario_id, fr.nome_referencia, fr.telefone_referencia, fr.resposta_json, fr.registrado_em,
                    fi.titulo AS formulario_titulo
             FROM montagem_formularios mf
             JOIN formularios_itens fi ON fi.id = mf.formulario_id AND fi.tenant_id = mf.tenant_id
             JOIN formularios_respostas fr ON fr.formulario_id = fi.id AND fr.tenant_id = mf.tenant_id
             WHERE mf.montagem_id = ? AND mf.tenant_id = ?
             ORDER BY fr.registrado_em DESC`,
            [montagemId, tenantId]
        );
        const parsed = rows.map((row) => ({
            ...row,
            resposta: parseJsonSafe(row.resposta_json, {})
        }));
        return res.json(parsed);
    } catch (err) {
        console.error('Erro ao listar encontristas:', err);
        return res.status(500).json({ error: 'Erro ao listar encontristas.' });
    }
});

router.get('/:id/encontristas-selecionados', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const montagemId = Number(req.params.id);
        if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
        await garantirMontagemFormularios();
        await garantirMontagemEncontristas();
        const hasMontagemEjcId = await hasColumn('jovens', 'montagem_ejc_id');
        const hasForms = await hasTable('formularios_itens');
        const hasRespostas = await hasTable('formularios_respostas');
        const parsed = [];

        if (hasForms && hasRespostas) {
            const [rows] = await pool.query(
                `SELECT fr.id, fr.formulario_id, fr.nome_referencia, fr.telefone_referencia, fr.resposta_json, fr.registrado_em,
                        fi.titulo AS formulario_titulo, me.created_at AS selecionado_em
                 FROM montagem_encontristas me
                 JOIN formularios_respostas fr ON fr.id = me.resposta_id AND fr.tenant_id = me.tenant_id
                 JOIN formularios_itens fi ON fi.id = fr.formulario_id AND fi.tenant_id = fr.tenant_id
                 JOIN montagem_formularios mf
                   ON mf.montagem_id = me.montagem_id
                  AND mf.formulario_id = fr.formulario_id
                  AND mf.tenant_id = me.tenant_id
                 WHERE me.montagem_id = ? AND me.tenant_id = ?
                 ORDER BY me.created_at DESC`,
                [montagemId, tenantId]
            );
            parsed.push(...rows.map((row) => ({
                ...row,
                resposta: parseJsonSafe(row.resposta_json, {})
            })));
        }

        if (hasMontagemEjcId) {
            const [jovensRows] = await pool.query(
                `SELECT j.id AS jovem_id,
                        j.nome_completo,
                        j.telefone,
                        NULL AS created_at,
                        j.nome_completo AS nome_referencia,
                        j.telefone AS telefone_referencia
                 FROM jovens j
                 WHERE j.tenant_id = ?
                   AND j.montagem_ejc_id = ?
                 ORDER BY j.nome_completo ASC`,
                [tenantId, montagemId]
            );
            parsed.push(...(jovensRows || []).map((row) => criarEncontristaListaMestre(row)));
        }

        parsed.sort((a, b) => String(b.selecionado_em || b.registrado_em || '').localeCompare(String(a.selecionado_em || a.registrado_em || '')));
        return res.json(parsed);
    } catch (err) {
        console.error('Erro ao listar encontristas selecionados:', err);
        return res.status(500).json({ error: 'Erro ao listar encontristas selecionados.' });
    }
});

router.post('/:id/encontristas-selecionados', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const montagemId = Number(req.params.id);
        const respostaId = Number(req.body && req.body.resposta_id);
        if (!montagemId || !respostaId) return res.status(400).json({ error: 'Dados inválidos.' });
        await garantirMontagemFormularios();
        await garantirMontagemEncontristas();
        const hasForms = await hasTable('formularios_itens');
        const hasRespostas = await hasTable('formularios_respostas');
        if (!hasForms || !hasRespostas) return res.status(404).json({ error: 'Formulários indisponíveis para esta montagem.' });

        const [valid] = await pool.query(
            `SELECT fr.id
             FROM montagem_formularios mf
             JOIN formularios_respostas fr ON fr.formulario_id = mf.formulario_id AND fr.tenant_id = mf.tenant_id
             WHERE mf.montagem_id = ? AND mf.tenant_id = ? AND fr.id = ?
             LIMIT 1`,
            [montagemId, tenantId, respostaId]
        );
        if (!valid.length) return res.status(404).json({ error: 'Ficha não encontrada para esta montagem.' });

        await pool.query(
            `INSERT INTO montagem_encontristas (tenant_id, montagem_id, resposta_id)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE created_at = created_at`,
            [tenantId, montagemId, respostaId]
        );
        return res.json({ message: 'Encontrista adicionado com sucesso.' });
    } catch (err) {
        console.error('Erro ao adicionar encontrista selecionado:', err);
        return res.status(500).json({ error: 'Erro ao adicionar encontrista.' });
    }
});

router.delete('/:id/encontristas-selecionados/:respostaId', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const montagemId = Number(req.params.id);
        const respostaId = Number(req.params.respostaId);
        if (!montagemId || !respostaId) return res.status(400).json({ error: 'Dados inválidos.' });
        await garantirMontagemEncontristas();
        const hasMontagemEjcId = await hasColumn('jovens', 'montagem_ejc_id');

        if (respostaId < 0 && hasMontagemEjcId) {
            const jovemId = Math.abs(respostaId);
            await pool.query(
                `UPDATE jovens
                 SET montagem_ejc_id = NULL
                 WHERE tenant_id = ? AND id = ? AND montagem_ejc_id = ?`,
                [tenantId, jovemId, montagemId]
            );
            await garantirMontagemEncontristasDados();
            await pool.query(
                `DELETE FROM montagem_encontristas_dados
                 WHERE tenant_id = ? AND montagem_id = ? AND resposta_id = ?`,
                [tenantId, montagemId, respostaId]
            );
            return res.json({ message: 'Encontrista removido com sucesso.' });
        }

        await pool.query(
            `DELETE FROM montagem_encontristas
             WHERE tenant_id = ? AND montagem_id = ? AND resposta_id = ?`,
            [tenantId, montagemId, respostaId]
        );
        await garantirMontagemEncontristasDados();
        await pool.query(
            `DELETE FROM montagem_encontristas_dados
             WHERE tenant_id = ? AND montagem_id = ? AND resposta_id = ?`,
            [tenantId, montagemId, respostaId]
        );
        return res.json({ message: 'Encontrista removido com sucesso.' });
    } catch (err) {
        console.error('Erro ao remover encontrista selecionado:', err);
        return res.status(500).json({ error: 'Erro ao remover encontrista.' });
    }
});

router.get('/:id/encontristas-dados', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const montagemId = Number(req.params.id);
        if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
        await garantirMontagemFormularios();
        await garantirMontagemEncontristas();
        await garantirMontagemEncontristasDados();
        const hasMontagemEjcId = await hasColumn('jovens', 'montagem_ejc_id');
        const hasForms = await hasTable('formularios_itens');
        const hasRespostas = await hasTable('formularios_respostas');
        const parsed = [];

        if (hasForms && hasRespostas) {
            const [rows] = await pool.query(
                `SELECT fr.id, fr.formulario_id, fr.nome_referencia, fr.telefone_referencia, fr.resposta_json, fr.registrado_em,
                        fi.titulo AS formulario_titulo,
                        med.nome_referencia AS nome_editado, med.telefone_referencia AS telefone_editado,
                        med.circulo, med.cep, med.endereco, med.numero, med.bairro, med.cidade, med.complemento,
                        med.latitude, med.longitude, med.updated_at AS dados_atualizados_em
                 FROM montagem_encontristas me
                 JOIN formularios_respostas fr ON fr.id = me.resposta_id AND fr.tenant_id = me.tenant_id
                 JOIN formularios_itens fi ON fi.id = fr.formulario_id AND fi.tenant_id = fr.tenant_id
                 JOIN montagem_formularios mf
                   ON mf.montagem_id = me.montagem_id
                  AND mf.formulario_id = fr.formulario_id
                  AND mf.tenant_id = me.tenant_id
                 LEFT JOIN montagem_encontristas_dados med
                   ON med.tenant_id = me.tenant_id
                  AND med.montagem_id = me.montagem_id
                  AND med.resposta_id = me.resposta_id
                 WHERE me.montagem_id = ? AND me.tenant_id = ?
                 ORDER BY me.created_at DESC`,
                [montagemId, tenantId]
            );
            parsed.push(...rows.map((row) => ({
                ...row,
                resposta: parseJsonSafe(row.resposta_json, {})
            })));
        }

        if (hasMontagemEjcId) {
            const [jovensRows] = await pool.query(
                `SELECT j.id AS jovem_id,
                        j.nome_completo,
                        j.telefone,
                        NULL AS created_at,
                        med.nome_referencia AS nome_editado,
                        med.telefone_referencia AS telefone_editado,
                        med.circulo, med.cep, med.endereco, med.numero, med.bairro, med.cidade, med.complemento,
                        med.latitude, med.longitude, med.updated_at AS dados_atualizados_em
                 FROM jovens j
                 LEFT JOIN montagem_encontristas_dados med
                   ON med.tenant_id = j.tenant_id
                  AND med.montagem_id = ?
                  AND med.resposta_id = -j.id
                 WHERE j.tenant_id = ?
                   AND j.montagem_ejc_id = ?
                 ORDER BY j.nome_completo ASC`,
                [montagemId, tenantId, montagemId]
            );
            parsed.push(...(jovensRows || []).map((row) => ({
                ...criarEncontristaListaMestre(row),
                nome_editado: row.nome_editado,
                telefone_editado: row.telefone_editado,
                circulo: row.circulo,
                cep: row.cep,
                endereco: row.endereco,
                numero: row.numero,
                bairro: row.bairro,
                cidade: row.cidade,
                complemento: row.complemento,
                latitude: row.latitude,
                longitude: row.longitude,
                dados_atualizados_em: row.dados_atualizados_em
            })));
        }

        return res.json(parsed);
    } catch (err) {
        console.error('Erro ao listar encontristas com dados:', err);
        return res.status(500).json({ error: 'Erro ao listar encontristas com dados.' });
    }
});

router.put('/:id/encontristas-dados/:respostaId', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const montagemId = Number(req.params.id);
        const respostaId = Number(req.params.respostaId);
        if (!montagemId || !respostaId) return res.status(400).json({ error: 'Dados inválidos.' });
        await garantirMontagemFormularios();
        await garantirMontagemEncontristas();
        await garantirMontagemEncontristasDados();
        const hasMontagemEjcId = await hasColumn('jovens', 'montagem_ejc_id');

        if (respostaId < 0 && hasMontagemEjcId) {
            const jovemId = Math.abs(respostaId);
            const [validJovem] = await pool.query(
                `SELECT id
                 FROM jovens
                 WHERE tenant_id = ? AND id = ? AND montagem_ejc_id = ?
                 LIMIT 1`,
                [tenantId, jovemId, montagemId]
            );
            if (!validJovem.length) return res.status(404).json({ error: 'Encontrista não encontrado na montagem.' });
        } else {
            const [valid] = await pool.query(
                `SELECT me.resposta_id
                 FROM montagem_encontristas me
                 WHERE me.tenant_id = ? AND me.montagem_id = ? AND me.resposta_id = ?
                 LIMIT 1`,
                [tenantId, montagemId, respostaId]
            );
            if (!valid.length) return res.status(404).json({ error: 'Encontrista não encontrado na montagem.' });
        }

        const nome = String((req.body && req.body.nome_referencia) || '').trim() || null;
        const telefone = String((req.body && req.body.telefone_referencia) || '').trim() || null;
        const circulo = String((req.body && req.body.circulo) || '').trim() || null;
        const cep = String((req.body && req.body.cep) || '').trim() || null;
        const endereco = String((req.body && req.body.endereco) || '').trim() || null;
        const numero = String((req.body && req.body.numero) || '').trim() || null;
        const bairro = String((req.body && req.body.bairro) || '').trim() || null;
        const cidade = String((req.body && req.body.cidade) || '').trim() || null;
        const complemento = String((req.body && req.body.complemento) || '').trim() || null;
        const latitude = req.body && req.body.latitude !== undefined && req.body.latitude !== null && req.body.latitude !== ''
            ? Number(req.body.latitude)
            : null;
        const longitude = req.body && req.body.longitude !== undefined && req.body.longitude !== null && req.body.longitude !== ''
            ? Number(req.body.longitude)
            : null;

        await pool.query(
            `INSERT INTO montagem_encontristas_dados
                (tenant_id, montagem_id, resposta_id, nome_referencia, telefone_referencia, circulo, cep, endereco, numero, bairro, cidade, complemento, latitude, longitude)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                nome_referencia = VALUES(nome_referencia),
                telefone_referencia = VALUES(telefone_referencia),
                circulo = VALUES(circulo),
                cep = VALUES(cep),
                endereco = VALUES(endereco),
                numero = VALUES(numero),
                bairro = VALUES(bairro),
                cidade = VALUES(cidade),
                complemento = VALUES(complemento),
                latitude = VALUES(latitude),
                longitude = VALUES(longitude)`,
            [tenantId, montagemId, respostaId, nome, telefone, circulo, cep, endereco, numero, bairro, cidade, complemento, latitude, longitude]
        );

        return res.json({ message: 'Dados do encontrista salvos com sucesso.' });
    } catch (err) {
        console.error('Erro ao salvar dados do encontrista:', err);
        return res.status(500).json({ error: 'Erro ao salvar dados do encontrista.' });
    }
});

function getNodeGeocoderInstance() {
    if (geocoderInstance) return geocoderInstance;
    if (!NodeGeocoder) return null;
    geocoderInstance = NodeGeocoder({
        provider: 'openstreetmap',
        httpAdapter: 'https',
        formatter: null
    });
    return geocoderInstance;
}

async function geocodificarEnderecoEscolhido(row) {
    const cep = String(row && row.cep ? row.cep : '').trim();
    const endereco = String(row && row.endereco ? row.endereco : '').trim();
    const numero = String(row && row.numero ? row.numero : '').trim();
    const bairro = String(row && row.bairro ? row.bairro : '').trim();
    const cidade = String(row && row.cidade ? row.cidade : '').trim();

    // Regra da tela: só geocodifica se tiver CEP + endereço + número.
    if (!cep || !endereco || !numero) return null;

    const geocoder = getNodeGeocoderInstance();
    if (!geocoder) return null;

    const consulta = [
        `${endereco}, ${numero}`,
        bairro || null,
        cidade || null,
        cep,
        'Brasil'
    ].filter(Boolean).join(', ');

    try {
        const results = await geocoder.geocode(consulta);
        if (!Array.isArray(results) || !results.length) return null;
        const lat = Number(results[0].latitude);
        const lon = Number(results[0].longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return { lat, lon };
    } catch (_) {
        return null;
    }
}

router.get('/:id/encontristas-mapa-contagem', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const montagemId = Number(req.params.id);
        if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
        await garantirMontagemEncontristasDados();

        const [rows] = await pool.query(
            `SELECT med.resposta_id, med.nome_referencia, med.telefone_referencia, med.cep, med.endereco, med.numero, med.bairro, med.cidade, med.complemento, med.latitude, med.longitude
             FROM montagem_encontristas_dados med
             JOIN montagem_encontristas me
               ON me.tenant_id = med.tenant_id
              AND me.montagem_id = med.montagem_id
              AND me.resposta_id = med.resposta_id
             WHERE med.tenant_id = ? AND med.montagem_id = ?`,
            [tenantId, montagemId]
        );

        for (const row of rows) {
            const latOk = Number.isFinite(Number(row.latitude));
            const lonOk = Number.isFinite(Number(row.longitude));
            if (latOk && lonOk) continue;
            const geo = await geocodificarEnderecoEscolhido(row);
            if (!geo) continue;
            row.latitude = geo.lat;
            row.longitude = geo.lon;
            await pool.query(
                `UPDATE montagem_encontristas_dados
                 SET latitude = ?, longitude = ?
                 WHERE tenant_id = ? AND montagem_id = ? AND resposta_id = ?`,
                [geo.lat, geo.lon, tenantId, montagemId, row.resposta_id]
            );
        }

        const buckets = new Map();
        for (const row of rows) {
            const lat = Number(row.latitude);
            const lon = Number(row.longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            const bairro = String(row.bairro || '').trim() || 'Sem bairro';
            const cidade = String(row.cidade || '').trim() || 'Sem cidade';
            const key = `${bairro}|${cidade}`;
            if (!buckets.has(key)) {
                buckets.set(key, { bairro, cidade, latitude: lat, longitude: lon, total: 0 });
            }
            buckets.get(key).total += 1;
        }

        const pontos = Array.from(buckets.values()).sort((a, b) => b.total - a.total || a.cidade.localeCompare(b.cidade));
        return res.json({ pontos, total: pontos.reduce((acc, p) => acc + Number(p.total || 0), 0) });
    } catch (err) {
        console.error('Erro ao montar mapa de contagem dos encontristas:', err);
        return res.status(500).json({ error: 'Erro ao montar mapa de contagem.' });
    }
});

// Criar montagem
router.post('/', async (req, res) => {
    const { numero_ejc, data_encontro, data_inicio_encontro, data_fim_encontro, data_tarde_revelacao, data_inicio_reunioes, data_fim_reunioes, dia_semana_reunioes } = req.body;
    const inicioEncontroRaw = data_inicio_encontro || data_encontro;
    const fimEncontroRaw = data_fim_encontro || data_encontro;
    if (!numero_ejc || !inicioEncontroRaw || !fimEncontroRaw || !data_tarde_revelacao || !data_inicio_reunioes || !data_fim_reunioes) {
        return res.status(400).json({ error: "Preencha número do EJC, início/fim do encontro, tarde de revelação e período das reuniões." });
    }

    const dataEncontro = normalizarDataEntrada(inicioEncontroRaw);
    const dataFimEncontro = normalizarDataEntrada(fimEncontroRaw);
    const dataTarde = normalizarDataEntrada(data_tarde_revelacao);
    const inicioReunioes = normalizarDataEntrada(data_inicio_reunioes);
    const fimReunioes = normalizarDataEntrada(data_fim_reunioes);
    const diaSemanaReunioes = normalizarDiaSemana(dia_semana_reunioes);
    if (!dataEncontro || !dataFimEncontro || !dataTarde || !inicioReunioes || !fimReunioes || diaSemanaReunioes === null) {
        return res.status(400).json({ error: "Informe todas as datas no formato dd/mm/aaaa." });
    }
    if (dataEncontro > dataFimEncontro) {
        return res.status(400).json({ error: "A data fim do encontro não pode ser menor que a data início." });
    }
    if (inicioReunioes > fimReunioes) {
        return res.status(400).json({ error: "A data fim das reuniões não pode ser menor que a data início." });
    }
    if (!gerarDatasReunioesPorDiaSemana(inicioReunioes, fimReunioes, diaSemanaReunioes).length) {
        return res.status(400).json({ error: "Não existe nenhuma reunião nesse dia da semana dentro do período informado." });
    }

    try {
        const tenantId = getTenantId(req);
        await garantirEstruturaMontagemMembrosExtra();
        await garantirEstruturaMontagemDatas();
        const erroNumero = await validarNumeroMontagemUnico({ tenantId, numero: numero_ejc });
        if (erroNumero) {
            return res.status(400).json({ error: erroNumero });
        }
        const comDataInicio = await hasMontagemDataInicioColumn();
        const comDataFim = await hasMontagemDataFimColumn();
        const comDataTarde = await hasMontagemDataTardeRevelacaoColumn();
        const comDataInicioReunioes = await hasMontagemDataInicioReunioesColumn();
        const comDataFimReunioes = await hasMontagemDataFimReunioesColumn();
        const comDiaSemanaReunioes = await hasMontagemDiaSemanaReunioesColumn();

        const cols = ['tenant_id', 'numero_ejc', 'data_encontro'];
        const vals = [tenantId, numero_ejc, dataEncontro];
        if (comDataTarde) { cols.push('data_tarde_revelacao'); vals.push(dataTarde); }
        if (comDataInicioReunioes) { cols.push('data_inicio_reunioes'); vals.push(inicioReunioes); }
        if (comDataFimReunioes) { cols.push('data_fim_reunioes'); vals.push(fimReunioes); }
        if (comDiaSemanaReunioes) { cols.push('dia_semana_reunioes'); vals.push(diaSemanaReunioes); }
        if (comDataInicio) { cols.push('data_inicio'); vals.push(dataEncontro); }
        if (comDataFim) { cols.push('data_fim'); vals.push(dataFimEncontro); }

        const placeholders = cols.map(() => '?').join(', ');
        const [result] = await pool.query(
            `INSERT INTO montagens (${cols.join(', ')}) VALUES (${placeholders})`,
            vals
        );
        await sincronizarEdicaoERegrasDaMontagem({
            tenantId,
            numeroEjc: numero_ejc,
            dataInicio: dataEncontro,
            dataFim: dataFimEncontro,
            dataEncontro,
            dataTardeRevelacao: dataTarde,
            dataInicioReunioes: inicioReunioes,
            dataFimReunioes: fimReunioes,
            diaSemanaReunioes
        });
        await recriarReunioesDaMontagem({
            montagemId: result.insertId,
            dataInicio: inicioReunioes,
            dataFim: fimReunioes,
            diaSemana: diaSemanaReunioes,
            periodo: null
        });
        res.json({ id: result.insertId, message: "Montagem de encontro iniciada" });
    } catch (err) {
        console.error("Erro ao criar montagem:", err);
        res.status(500).json({ error: "Erro ao criar montagem" });
    }
});

// Atualizar informações da montagem (ex: número EJC e datas)
router.put('/:id', async (req, res) => {
    const montagemId = Number(req.params.id);
    const { numero_ejc, data_encontro, data_inicio_encontro, data_fim_encontro, data_tarde_revelacao, data_inicio_reunioes, data_fim_reunioes, dia_semana_reunioes } = req.body || {};
    if (!montagemId) return res.status(400).json({ error: 'Montagem inválida.' });
    const inicioEncontroRaw = data_inicio_encontro || data_encontro;
    const fimEncontroRaw = data_fim_encontro || data_encontro;
    if (!numero_ejc || !inicioEncontroRaw || !fimEncontroRaw || !data_tarde_revelacao || !data_inicio_reunioes || !data_fim_reunioes) {
        return res.status(400).json({ error: 'Preencha número do EJC, início/fim do encontro, tarde de revelação e período das reuniões.' });
    }

    const dataEncontro = normalizarDataEntrada(inicioEncontroRaw);
    const dataFimEncontro = normalizarDataEntrada(fimEncontroRaw);
    const dataTarde = normalizarDataEntrada(data_tarde_revelacao);
    const inicioReunioes = normalizarDataEntrada(data_inicio_reunioes);
    const fimReunioes = normalizarDataEntrada(data_fim_reunioes);
    const diaSemanaReunioes = normalizarDiaSemana(dia_semana_reunioes);
    if (!dataEncontro || !dataFimEncontro || !dataTarde || !inicioReunioes || !fimReunioes || diaSemanaReunioes === null) {
        return res.status(400).json({ error: 'Informe todas as datas no formato dd/mm/aaaa.' });
    }
    if (dataEncontro > dataFimEncontro) {
        return res.status(400).json({ error: 'A data fim do encontro não pode ser menor que a data início.' });
    }
    if (inicioReunioes > fimReunioes) {
        return res.status(400).json({ error: 'A data fim das reuniões não pode ser menor que a data início.' });
    }
    if (!gerarDatasReunioesPorDiaSemana(inicioReunioes, fimReunioes, diaSemanaReunioes).length) {
        return res.status(400).json({ error: 'Não existe nenhuma reunião nesse dia da semana dentro do período informado.' });
    }

    try {
        const tenantId = getTenantId(req);
        await garantirEstruturaMontagemMembrosExtra();
        await garantirEstruturaMontagemDatas();
        const [exists] = await pool.query('SELECT id FROM montagens WHERE id = ? AND tenant_id = ? LIMIT 1', [montagemId, tenantId]);
        if (!exists.length) return res.status(404).json({ error: 'Montagem não encontrada.' });
        const erroNumero = await validarNumeroMontagemUnico({ tenantId, numero: numero_ejc, montagemIdIgnorar: montagemId });
        if (erroNumero) {
            return res.status(400).json({ error: erroNumero });
        }

        const comDataInicio = await hasMontagemDataInicioColumn();
        const comDataFim = await hasMontagemDataFimColumn();
        const comDataTarde = await hasMontagemDataTardeRevelacaoColumn();
        const comDataInicioReunioes = await hasMontagemDataInicioReunioesColumn();
        const comDataFimReunioes = await hasMontagemDataFimReunioesColumn();
        const comDiaSemanaReunioes = await hasMontagemDiaSemanaReunioesColumn();

        const sets = ['numero_ejc = ?', 'data_encontro = ?'];
        const params = [numero_ejc, dataEncontro];
        if (comDataTarde) { sets.push('data_tarde_revelacao = ?'); params.push(dataTarde); }
        if (comDataInicioReunioes) { sets.push('data_inicio_reunioes = ?'); params.push(inicioReunioes); }
        if (comDataFimReunioes) { sets.push('data_fim_reunioes = ?'); params.push(fimReunioes); }
        if (comDiaSemanaReunioes) { sets.push('dia_semana_reunioes = ?'); params.push(diaSemanaReunioes); }
        if (comDataInicio) { sets.push('data_inicio = ?'); params.push(dataEncontro); }
        if (comDataFim) { sets.push('data_fim = ?'); params.push(dataFimEncontro); }
        params.push(montagemId, tenantId);

        await pool.query(
            `UPDATE montagens SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`,
            params
        );
        await sincronizarEdicaoERegrasDaMontagem({
            tenantId,
            numeroEjc: numero_ejc,
            dataInicio: dataEncontro,
            dataFim: dataFimEncontro,
            dataEncontro,
            dataTardeRevelacao: dataTarde,
            dataInicioReunioes: inicioReunioes,
            dataFimReunioes: fimReunioes,
            diaSemanaReunioes
        });
        await recriarReunioesDaMontagem({
            montagemId,
            dataInicio: inicioReunioes,
            dataFim: fimReunioes,
            diaSemana: diaSemanaReunioes,
            periodo: null
        });

        return res.json({ message: 'Montagem atualizada com sucesso.' });
    } catch (err) {
        console.error('Erro ao atualizar montagem:', err);
        return res.status(500).json({ error: 'Erro ao atualizar montagem.' });
    }
});

// Deletar montagem
router.delete('/:id', async (req, res) => {
    const montagemId = req.params.id;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const tenantId = getTenantId(req);

        const [[montagem]] = await connection.query(
            'SELECT id, numero_ejc FROM montagens WHERE id = ? AND tenant_id = ? LIMIT 1',
            [montagemId, tenantId]
        );
        if (!montagem) {
            await connection.rollback();
            return res.status(404).json({ error: "Montagem não encontrada" });
        }

        const edicaoMontagem = montarEtiquetaEdicao(montagem.numero_ejc);
        const edicaoMontagemAlt = `${montagem.numero_ejc}° EJC (Montagem)`;
        const likeMontagemNumero = `${montagem.numero_ejc}%EJC (Montagem)%`;

        await connection.query('DELETE FROM montagem_membros WHERE montagem_id = ? AND tenant_id = ?', [montagemId, tenantId]);
        await connection.query(
            `DELETE FROM historico_equipes
             WHERE edicao_ejc = ?
                OR edicao_ejc = ?
                OR edicao_ejc LIKE ?`,
            [edicaoMontagem, edicaoMontagemAlt, likeMontagemNumero]
        );
        await connection.query('DELETE FROM montagens WHERE id = ? AND tenant_id = ?', [montagemId, tenantId]);

        await connection.commit();
        res.json({ message: "Montagem deletada com sucesso" });
    } catch (err) {
        await connection.rollback();
        console.error("Erro ao deletar montagem:", err);
        res.status(500).json({ error: "Erro ao deletar" });
    } finally {
        connection.release();
    }
});

// Buscar equipes, funções e membros associados à montagem
router.get('/:id/estrutura', async (req, res) => {
    const montagemId = req.params.id;
    try {
        const tenantId = getTenantId(req);
        await garantirEstruturaMontagemMembrosExtra();
        await ensureEquipeSexoLimitsColumns();
        const comPapelBase = await hasPapelBaseColumn();
        const papelBaseSelect = comPapelBase
            ? 'COALESCE(ef.papel_base, "Membro")'
            : '"Membro"';
        const [equipesFuncoes] = await pool.query(`
            SELECT eq.id as equipe_id, eq.nome as equipe_nome, COALESCE(eq.membros_outro_ejc, 0) AS membros_outro_ejc,
                   eq.limite_homens, eq.limite_mulheres,
                   ef.id as funcao_id, ef.nome as funcao_nome, ${papelBaseSelect} as papel_base
            FROM equipes eq
            LEFT JOIN equipes_funcoes ef ON eq.id = ef.equipe_id
                                        AND ef.tenant_id = eq.tenant_id
            WHERE eq.tenant_id = ?
            ORDER BY eq.nome ASC, ef.nome ASC
        `, [tenantId]);

        const [membros] = await pool.query(`
            SELECT mm.id as membro_id, mm.equipe_id, mm.funcao_id, mm.jovem_id, j.nome_completo as jovem_nome, j.telefone, j.sexo,
                   mm.status_ligacao, mm.motivo_recusa, mm.eh_substituicao, mm.nome_externo, mm.telefone_externo,
                   tc.id AS tio_casal_id, tc.telefone_tio, tc.telefone_tia
            FROM montagem_membros mm
            LEFT JOIN jovens j ON mm.jovem_id = j.id
            LEFT JOIN tios_casais tc
              ON tc.tenant_id = mm.tenant_id
             AND TRIM(CONCAT(COALESCE(tc.nome_tio, ''), ' e ', COALESCE(tc.nome_tia, ''))) = TRIM(COALESCE(mm.nome_externo, ''))
            WHERE mm.montagem_id = ?
              AND mm.tenant_id = ?
              AND (mm.status_ligacao IS NULL OR mm.status_ligacao <> 'RECUSOU')
        `, [montagemId, tenantId]);

        const estrutura = {};
        for (let row of equipesFuncoes) {
            if (!estrutura[row.equipe_id]) {
                estrutura[row.equipe_id] = {
                    id: row.equipe_id,
                    nome: row.equipe_nome,
                    membros_outro_ejc: row.membros_outro_ejc ? 1 : 0,
                    limite_homens: row.limite_homens === null ? null : Number(row.limite_homens),
                    limite_mulheres: row.limite_mulheres === null ? null : Number(row.limite_mulheres),
                    funcoes: []
                };
            }

            if (row.funcao_id) {
                const memberInRole = membros.filter(m => m.equipe_id === row.equipe_id && m.funcao_id === row.funcao_id)
                    .map((m) => ({
                        ...m,
                        eh_casal_tios: !!(Number(m.tio_casal_id) > 0 && !m.jovem_id)
                    }));
                estrutura[row.equipe_id].funcoes.push({
                    id: row.funcao_id,
                    nome: row.funcao_nome,
                    papel_base: row.papel_base || 'Membro',
                    membros: memberInRole
                });
            }
        }
        res.json(Object.values(estrutura));
    } catch (err) {
        console.error("Erro ao buscar estrutura:", err);
        res.status(500).json({ error: "Erro ao buscar estrutura" });
    }
});

router.get('/:id/info', async (req, res) => {
    const montagemId = Number(req.params.id);
    if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
    try {
        const tenantId = getTenantId(req);
        await garantirEstruturaMontagemMembrosExtra();
        const temPapelBase = await hasPapelBaseColumn();
        const papelBaseSelect = temPapelBase ? "COALESCE(ef.papel_base, 'Membro')" : "'Membro'";
        const temTabelaTios = await hasTable('tios_casais');

        const joinsTios = temTabelaTios
            ? `LEFT JOIN tios_casais tc
                  ON tc.tenant_id = mm.tenant_id
                 AND TRIM(CONCAT(COALESCE(tc.nome_tio, ''), ' e ', COALESCE(tc.nome_tia, ''))) = TRIM(COALESCE(mm.nome_externo, ''))`
            : '';
        const selectTios = temTabelaTios
            ? `, COALESCE(tc.restricao_alimentar, 0) AS tio_restricao_alimentar,
               COALESCE(tc.restricao_alimentar_tio, 0) AS tio_restricao_alimentar_tio,
               NULLIF(TRIM(tc.detalhes_restricao_tio), '') AS detalhes_restricao_tio,
               COALESCE(tc.restricao_alimentar_tia, 0) AS tio_restricao_alimentar_tia,
               NULLIF(TRIM(tc.detalhes_restricao_tia), '') AS detalhes_restricao_tia,
               NULLIF(TRIM(tc.nome_tio), '') AS nome_tio,
               NULLIF(TRIM(tc.nome_tia), '') AS nome_tia,
               NULLIF(TRIM(tc.telefone_tio), '') AS telefone_tio,
               NULLIF(TRIM(tc.telefone_tia), '') AS telefone_tia`
            : `, 0 AS tio_restricao_alimentar,
               0 AS tio_restricao_alimentar_tio,
               NULL AS detalhes_restricao_tio,
               0 AS tio_restricao_alimentar_tia,
               NULL AS detalhes_restricao_tia,
               NULL AS nome_tio,
               NULL AS nome_tia,
               NULL AS telefone_tio,
               NULL AS telefone_tia`;

        const [rows] = await pool.query(
            `SELECT mm.id AS membro_id,
                    mm.jovem_id,
                    mm.nome_externo,
                    mm.telefone_externo,
                    e.nome AS equipe_nome,
                    ef.nome AS funcao_nome,
                    ${papelBaseSelect} AS papel_base,
                    j.nome_completo AS jovem_nome,
                    j.telefone AS jovem_telefone,
                    j.data_nascimento AS jovem_data_nascimento,
                    CASE
                        WHEN j.data_nascimento IS NULL THEN NULL
                        ELSE TIMESTAMPDIFF(YEAR, j.data_nascimento, CURDATE())
                    END AS idade,
                    COALESCE(j.restricao_alimentar, 0) AS jovem_restricao_alimentar,
                    NULLIF(TRIM(j.detalhes_restricao), '') AS detalhes_restricao
                    ${selectTios}
             FROM montagem_membros mm
             JOIN equipes e ON e.id = mm.equipe_id
             JOIN equipes_funcoes ef ON ef.id = mm.funcao_id
             LEFT JOIN jovens j ON j.id = mm.jovem_id
             ${joinsTios}
             WHERE mm.montagem_id = ?
               AND mm.tenant_id = ?
               AND mm.eh_substituicao = 0
               AND mm.status_ligacao = 'ACEITOU'
             ORDER BY e.nome ASC, COALESCE(j.nome_completo, mm.nome_externo) ASC`,
            [montagemId, tenantId]
        );

        await garantirMontagemFormularios();
        await garantirMontagemEncontristas();
        const hasForms = await hasTable('formularios_itens');
        const hasRespostas = await hasTable('formularios_respostas');
        let encontristasSelecionados = [];
        if (hasForms && hasRespostas) {
            const [encontristasRows] = await pool.query(
                `SELECT fr.id AS resposta_id,
                        fr.nome_referencia,
                        fr.telefone_referencia,
                        fr.resposta_json
                 FROM montagem_encontristas me
                 JOIN formularios_respostas fr ON fr.id = me.resposta_id AND fr.tenant_id = me.tenant_id
                 WHERE me.montagem_id = ? AND me.tenant_id = ?
                 ORDER BY me.created_at DESC`,
                [montagemId, tenantId]
            );
            encontristasSelecionados = (encontristasRows || []).map((row) => ({
                resposta_id: Number(row.resposta_id) || null,
                nome: String(row.nome_referencia || '').trim(),
                telefone: String(row.telefone_referencia || '').trim() || null,
                resposta: parseJsonSafe(row.resposta_json, {})
            }));
        }

        const coordenadores = [];
        const coordenadoresSet = new Set();
        const restricoesMap = new Map();
        const restricoesPessoasSet = new Set();
        const adicionarRestricao = (tipo, grupo, detalhe, chavePessoa) => {
            const nomeGrupo = grupo === 'encontristas' ? 'encontristas' : 'encontreiros';
            const totalGrupoKey = grupo === 'encontristas' ? 'encontristasTotal' : 'encontreirosTotal';
            if (!restricoesMap.has(tipo)) {
                restricoesMap.set(tipo, criarBucketRestricao(tipo));
            }
            const item = restricoesMap.get(tipo);
            item.total += 1;
            item[totalGrupoKey] += 1;
            item[nomeGrupo].push(detalhe);
            if (chavePessoa) restricoesPessoasSet.add(chavePessoa);
        };

        for (const row of (rows || [])) {
            const nome = String(row.jovem_nome || row.nome_externo || '').trim();
            if (!nome) continue;
            const telefone = String(row.jovem_telefone || row.telefone_externo || '').trim() || null;
            const idade = row.idade === null || row.idade === undefined ? null : Number(row.idade);
            const detalheBase = {
                membro_id: Number(row.membro_id) || null,
                nome,
                equipe: row.equipe_nome || '-',
                telefone,
                idade: Number.isFinite(idade) ? idade : null
            };

            if (ehFuncaoCoordenador(row.funcao_nome, row.papel_base)) {
                const chaveCoordenador = [
                    Number(row.membro_id) || 0,
                    nome.toLowerCase(),
                    String(row.equipe_nome || '').trim().toLowerCase(),
                    String(row.funcao_nome || '').trim().toLowerCase()
                ].join('|');
                if (!coordenadoresSet.has(chaveCoordenador)) {
                    coordenadoresSet.add(chaveCoordenador);
                    coordenadores.push({
                        ...detalheBase,
                        funcao: row.funcao_nome || 'Coordenador'
                    });
                }
            }

            const tiposRestricao = [];
            if (Number(row.jovem_restricao_alimentar) === 1) {
                tiposRestricao.push(...extrairTiposRestricaoAlimentar(row.detalhes_restricao));
            }

            if (tiposRestricao.length) {
                const chaveRestricaoPessoa = row.jovem_id
                    ? `jovem:${Number(row.jovem_id)}`
                    : `membro:${Number(row.membro_id) || nome.toLowerCase()}`;
                for (const tipo of tiposRestricao) {
                    adicionarRestricao(tipo, 'encontreiros', detalheBase, chaveRestricaoPessoa);
                }
            }

            if (!row.jovem_id && Number(row.tio_restricao_alimentar) === 1) {
                const pessoasTio = [
                    {
                        chave: `tio:${Number(row.membro_id) || 0}:tio`,
                        nome: String(row.nome_tio || '').trim(),
                        telefone: String(row.telefone_tio || row.telefone_externo || '').trim() || null,
                        detalhes: extrairTiposRestricaoAlimentar(row.detalhes_restricao_tio)
                    },
                    {
                        chave: `tio:${Number(row.membro_id) || 0}:tia`,
                        nome: String(row.nome_tia || '').trim(),
                        telefone: String(row.telefone_tia || row.telefone_externo || '').trim() || null,
                        detalhes: extrairTiposRestricaoAlimentar(row.detalhes_restricao_tia)
                    }
                ].filter((item) => item.nome && (
                    (item.chave.endsWith(':tio') && Number(row.tio_restricao_alimentar_tio) === 1) ||
                    (item.chave.endsWith(':tia') && Number(row.tio_restricao_alimentar_tia) === 1)
                ));

                for (const pessoa of pessoasTio) {
                    const detalhePessoa = {
                        membro_id: `${Number(row.membro_id) || 0}-${pessoa.chave.endsWith(':tio') ? 'tio' : 'tia'}`,
                        nome: pessoa.nome,
                        equipe: row.equipe_nome || '-',
                        telefone: pessoa.telefone,
                        idade: null
                    };
                    for (const tipo of (pessoa.detalhes || [])) {
                        adicionarRestricao(tipo, 'encontreiros', detalhePessoa, pessoa.chave);
                    }
                }
            }
        }

        for (const item of (encontristasSelecionados || [])) {
            const nome = String(item.nome || '').trim();
            if (!nome) continue;
            const detalhesTexto = extrairDetalhesRestricaoEncontrista(item.resposta);
            if (!detalhesTexto) continue;
            const tipos = extrairTiposRestricaoAlimentar(detalhesTexto);
            const detalheBase = {
                membro_id: `encontrista-${Number(item.resposta_id) || nome.toLowerCase()}`,
                nome,
                equipe: 'Encontristas escolhidos',
                telefone: item.telefone || null,
                idade: null
            };
            const chavePessoa = `encontrista:${Number(item.resposta_id) || nome.toLowerCase()}`;
            for (const tipo of tipos) {
                adicionarRestricao(tipo, 'encontristas', detalheBase, chavePessoa);
            }
        }

        coordenadores.sort((a, b) =>
            String(a.equipe || '').localeCompare(String(b.equipe || ''), 'pt-BR') ||
            String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR')
        );

        const restricoes = Array.from(restricoesMap.values())
            .map((item) => ({
                ...item,
                encontreiros: (item.encontreiros || []).sort((a, b) =>
                    String(a.equipe || '').localeCompare(String(b.equipe || ''), 'pt-BR') ||
                    String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR')
                ),
                encontristas: (item.encontristas || []).sort((a, b) =>
                    String(a.equipe || '').localeCompare(String(b.equipe || ''), 'pt-BR') ||
                    String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR')
                )
            }))
            .sort((a, b) => Number(b.total || 0) - Number(a.total || 0) || String(a.tipo || '').localeCompare(String(b.tipo || ''), 'pt-BR'));

        return res.json({
            coordenadores,
            restricoes,
            totalPessoasComRestricao: restricoesPessoasSet.size
        });
    } catch (err) {
        console.error('Erro ao buscar info da montagem:', err);
        return res.status(500).json({ error: 'Erro ao buscar informações da montagem.' });
    }
});

router.get('/:id/jovens-para-servir', async (req, res) => {
    const montagemId = Number(req.params.id);
    if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
    try {
        await garantirEstruturaMontagemJovensServir();
        const [rows] = await pool.query(`
            SELECT
                j.id,
                j.nome_completo,
                j.numero_ejc_fez,
                j.outro_ejc_numero,
                j.outro_ejc_id,
                j.data_nascimento,
                j.sexo,
                j.estado_civil,
                COALESCE(j.eh_musico, 0) AS eh_musico,
                COALESCE(j.origem_ejc_tipo, 'INCONFIDENTES') AS origem_ejc_tipo,
                oe.nome AS outro_ejc_nome,
                oe.paroquia AS outro_ejc_paroquia,
                COALESCE(mjs.pode_servir, 0) AS pode_servir
            FROM jovens j
            LEFT JOIN outros_ejcs oe ON oe.id = j.outro_ejc_id
            LEFT JOIN montagem_jovens_servir mjs ON mjs.jovem_id = j.id AND mjs.montagem_id = ?
            ORDER BY j.nome_completo ASC
        `, [montagemId]);
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar jovens para servir:', err);
        return res.status(500).json({ error: 'Erro ao listar jovens para servir.' });
    }
});

router.get('/:id/jovens-sem-equipe', async (req, res) => {
    const montagemId = Number(req.params.id);
    if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
    try {
        const tenantId = getTenantId(req);
        await garantirEstruturaMontagemJovensServir();
        await ensureNaoServeEjcColumns();
        const hasJovens = await hasTable('jovens');
        const hasMontagemMembros = await hasTable('montagem_membros');
        const hasMontagemEjcId = await hasColumn('jovens', 'montagem_ejc_id');
        const hasTiosCasais = await hasTable('tios_casais');
        const hasConjugeId = await hasColumn('jovens', 'conjuge_id');
        const hasConjugeNome = await hasColumn('jovens', 'conjuge_nome');
        const hasConjugeOutroEjcId = await hasColumn('jovens', 'conjuge_outro_ejc_id');
        if (!hasJovens || !hasMontagemMembros) return res.json([]);

        const tiosJoin = hasTiosCasais
            ? `LEFT JOIN tios_casais tc
                 ON tc.tenant_id = j.tenant_id
                AND (LOWER(tc.nome_tio) = LOWER(j.nome_completo) OR LOWER(tc.nome_tia) = LOWER(j.nome_completo))`
            : '';
        const tiosWhere = hasTiosCasais ? 'AND tc.id IS NULL' : '';
        const encontristasWhere = hasMontagemEjcId ? 'AND j.montagem_ejc_id IS NULL' : '';

        const [rows] = await pool.query(`
            SELECT
                j.id,
                j.nome_completo,
                j.telefone,
                j.data_nascimento,
                j.numero_ejc_fez,
                COALESCE(j.origem_ejc_tipo, 'INCONFIDENTES') AS origem_ejc_tipo,
                j.outro_ejc_numero,
                COALESCE(e_id.numero, e_num.numero) AS ejc_numero_fez,
                COALESCE(e_id.paroquia, e_num.paroquia) AS ejc_paroquia_fez,
                j.sexo,
                j.circulo,
                ${hasConjugeId ? 'j.conjuge_id' : 'NULL AS conjuge_id'},
                ${hasConjugeNome ? 'j.conjuge_nome' : 'NULL AS conjuge_nome'},
                ${hasConjugeOutroEjcId ? 'j.conjuge_outro_ejc_id' : 'NULL AS conjuge_outro_ejc_id'},
                COALESCE(mjs.pode_servir, 0) AS pode_servir,
                COALESCE(mjs.destino, 'titular') AS destino
            FROM jovens j
            LEFT JOIN ejc e_id
              ON e_id.id = j.numero_ejc_fez
             AND e_id.tenant_id = j.tenant_id
            LEFT JOIN ejc e_num
              ON e_num.numero = j.numero_ejc_fez
             AND e_num.tenant_id = j.tenant_id
            LEFT JOIN montagem_membros mm
              ON mm.jovem_id = j.id
             AND mm.montagem_id = ?
             AND mm.tenant_id = j.tenant_id
            LEFT JOIN montagem_jovens_servir mjs
              ON mjs.jovem_id = j.id
             AND mjs.montagem_id = ?
            ${tiosJoin}
            WHERE j.tenant_id = ?
              AND COALESCE(j.origem_ejc_tipo, 'INCONFIDENTES') <> 'OUTRO_EJC'
              AND COALESCE(j.lista_mestre_ativo, 1) = 1
              AND COALESCE(j.nao_serve_ejc, 0) = 0
              ${encontristasWhere}
              AND mm.id IS NULL
              ${tiosWhere}
            ORDER BY j.nome_completo ASC
        `, [montagemId, montagemId, tenantId]);
        return res.json((rows || []).map((row) => {
            const casalKey = obterChaveCasalJovem(row);
            return {
                ...row,
                casal_key: casalKey || null,
                conjuge_nome_exibicao: row.conjuge_nome || null
            };
        }));
    } catch (err) {
        console.error('Erro ao listar jovens sem equipe:', err);
        return res.status(500).json({ error: 'Erro ao listar jovens sem equipe.' });
    }
});

router.post('/:id/jovens-servir/selecionar', async (req, res) => {
    const montagemId = Number(req.params.id);
    if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
    try {
        await garantirEstruturaMontagemJovensServir();
        const tenantId = getTenantId(req);
        const itens = Array.isArray(req.body && req.body.itens) ? req.body.itens : null;
        if (itens) {
            await pool.query('DELETE FROM montagem_jovens_servir WHERE montagem_id = ?', [montagemId]);
            const values = itens
                .map((item) => ({
                    jovemId: Number(item && item.id),
                    podeServir: item && item.selecionado ? 1 : 0,
                    destino: normalizarDestinoSelecao(item && item.destino)
                }))
                .filter((item) => Number.isInteger(item.jovemId) && item.jovemId > 0);
            if (values.length) {
                await pool.query(
                    `INSERT INTO montagem_jovens_servir (montagem_id, jovem_id, pode_servir, destino)
                     VALUES ?`,
                    [values.map((item) => [montagemId, item.jovemId, item.podeServir, item.destino])]
                );
            }
        } else {
            const ids = Array.isArray(req.body && req.body.jovem_ids) ? req.body.jovem_ids : [];
            const selecionados = ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0);

            if (selecionados.length) {
                const placeholders = selecionados.map(() => '?').join(',');
                await pool.query(
                    `UPDATE montagem_jovens_servir
                     SET pode_servir = 0
                     WHERE montagem_id = ?
                       AND jovem_id NOT IN (${placeholders})`,
                    [montagemId, ...selecionados]
                );
            } else {
                await pool.query(
                    `UPDATE montagem_jovens_servir
                     SET pode_servir = 0
                     WHERE montagem_id = ?`,
                    [montagemId]
                );
            }

            for (const jovemId of selecionados) {
                // eslint-disable-next-line no-await-in-loop
                await pool.query(
                    `INSERT INTO montagem_jovens_servir (montagem_id, jovem_id, pode_servir, destino)
                     VALUES (?, ?, 1, 'titular')
                     ON DUPLICATE KEY UPDATE pode_servir = 1, destino = 'titular'`,
                    [montagemId, jovemId]
                );
            }
        }

        return res.json({ message: 'Seleção salva com sucesso.' });
    } catch (err) {
        console.error('Erro ao salvar seleção de jovens para servir:', err);
        return res.status(500).json({ error: 'Erro ao salvar seleção.' });
    }
});

router.post('/:id/jovens-servir/distribuir', async (req, res) => {
    const montagemId = Number(req.params.id);
    if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
    const connection = await pool.getConnection();
    try {
        const tenantId = getTenantId(req);
        const destino = normalizarDestinoSelecao(req.body && req.body.destino);
        const ehSubstituicao = destino === 'reserva' ? 1 : 0;
        const excluidas = Array.isArray(req.body && req.body.excluir_equipes)
            ? req.body.excluir_equipes.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
            : [];
        const excluirSet = new Set(excluidas);
        await garantirEstruturaMontagemJovensServir();
        await garantirEstruturaMontagemMembrosExtra();
        await ensureEquipeSexoLimitsColumns();
        const hasJovens = await hasTable('jovens');
        const hasMontagemMembros = await hasTable('montagem_membros');
        const hasHistorico = await hasTable('historico_equipes');
        const hasConjugeId = await hasColumn('jovens', 'conjuge_id');
        const hasConjugeNome = await hasColumn('jovens', 'conjuge_nome');
        const hasConjugeOutroEjcId = await hasColumn('jovens', 'conjuge_outro_ejc_id');
        if (!hasJovens || !hasMontagemMembros) {
            return res.status(400).json({ error: 'Estrutura de montagem não encontrada.' });
        }

        const [selecionadosRows] = await connection.query(`
            SELECT j.id, j.nome_completo, j.sexo,
                   ${hasConjugeId ? 'j.conjuge_id' : 'NULL AS conjuge_id'},
                   ${hasConjugeNome ? 'j.conjuge_nome' : 'NULL AS conjuge_nome'},
                   ${hasConjugeOutroEjcId ? 'j.conjuge_outro_ejc_id' : 'NULL AS conjuge_outro_ejc_id'}
            FROM montagem_jovens_servir mjs
            JOIN jovens j ON j.id = mjs.jovem_id
            WHERE mjs.montagem_id = ?
              AND mjs.pode_servir = 1
              AND COALESCE(mjs.destino, 'titular') = ?
              AND j.tenant_id = ?
        `, [montagemId, destino, tenantId]);

        const selecionados = (selecionadosRows || []).map(r => ({
            id: Number(r.id),
            nome: r.nome_completo || '',
            sexo: r.sexo || null,
            conjuge_id: Number(r.conjuge_id) || null,
            conjuge_nome: r.conjuge_nome || null,
            conjuge_outro_ejc_id: Number(r.conjuge_outro_ejc_id) || null
        })).filter(r => r.id);

        if (!selecionados.length) {
            return res.status(400).json({ error: 'Nenhum jovem selecionado para servir.' });
        }

        const [alocadosRows] = await connection.query(`
            SELECT mm.equipe_id, mm.jovem_id, mm.nome_externo, mm.telefone_externo, j.sexo,
                   tc.id AS tio_casal_id
            FROM montagem_membros mm
            LEFT JOIN jovens j ON j.id = mm.jovem_id
            LEFT JOIN tios_casais tc
              ON tc.tenant_id = mm.tenant_id
             AND TRIM(CONCAT(COALESCE(tc.nome_tio, ''), ' e ', COALESCE(tc.nome_tia, ''))) = TRIM(COALESCE(mm.nome_externo, ''))
            WHERE mm.montagem_id = ?
              AND mm.tenant_id = ?
        `, [montagemId, tenantId]);
        const jaAlocados = new Set((alocadosRows || []).map(r => Number(r.jovem_id)).filter(Boolean));
        const alocadoEquipePorJovemId = new Map();
        const alocadoEquipePorOutroKey = new Map();
        for (const row of (alocadosRows || [])) {
            const jovemId = Number(row.jovem_id) || 0;
            const equipeId = Number(row.equipe_id) || 0;
            if (jovemId > 0 && equipeId > 0) alocadoEquipePorJovemId.set(jovemId, equipeId);
            const outroKey = obterChaveItemOutroEjc(row);
            if (outroKey && equipeId > 0) alocadoEquipePorOutroKey.set(outroKey, equipeId);
        }
        const pendentes = selecionados.filter(j => !jaAlocados.has(j.id));

        if (!pendentes.length) {
            return res.json({ message: 'Todos os selecionados já estão alocados.', distribuidos: 0, ignorados: selecionados.length, sem_equipe: [] });
        }

        const comPapelBase = await hasPapelBaseColumn();
        const papelBaseSelect = comPapelBase ? 'COALESCE(ef.papel_base, "Membro")' : '"Membro"';
        const [equipesFuncoes] = await connection.query(`
            SELECT eq.id as equipe_id, eq.nome as equipe_nome, COALESCE(eq.membros_outro_ejc, 0) AS membros_outro_ejc,
                   eq.limite_homens, eq.limite_mulheres,
                   ef.id as funcao_id, ef.nome as funcao_nome, ${papelBaseSelect} as papel_base
            FROM equipes eq
            LEFT JOIN equipes_funcoes ef ON eq.id = ef.equipe_id
            ORDER BY eq.nome ASC, ef.nome ASC
        `);

        const equipeMap = new Map();
        for (const row of (equipesFuncoes || [])) {
            if (excluirSet.has(Number(row.equipe_id))) continue;
            if (row.membros_outro_ejc) continue;
            if (!equipeMap.has(row.equipe_id)) {
                equipeMap.set(row.equipe_id, {
                    id: row.equipe_id,
                    nome: row.equipe_nome || '',
                    limite_homens: row.limite_homens === null ? null : Number(row.limite_homens),
                    limite_mulheres: row.limite_mulheres === null ? null : Number(row.limite_mulheres),
                    funcao_id: null,
                    funcoes: []
                });
            }
            if (row.funcao_id) {
                equipeMap.get(row.equipe_id).funcoes.push({
                    id: row.funcao_id,
                    nome: row.funcao_nome || '',
                    papel_base: row.papel_base || 'Membro'
                });
            }
        }

        const equipes = Array.from(equipeMap.values()).map((eq) => {
            let funcaoId = null;
            if (eq.funcoes.length) {
                const membro = eq.funcoes.find(f => String(f.papel_base || '').toLowerCase() === 'membro')
                    || eq.funcoes.find(f => String(f.nome || '').toLowerCase().includes('membro'))
                    || eq.funcoes[0];
                funcaoId = membro ? membro.id : null;
            }
            return { ...eq, funcao_id: funcaoId };
        }).filter(eq => !!eq.funcao_id);

        if (!equipes.length) {
            return res.status(400).json({ error: 'Nenhuma equipe com função de membro encontrada.' });
        }

        const historicoMap = new Map();
        if (hasHistorico) {
            const ids = pendentes.map(p => p.id);
            const placeholders = ids.map(() => '?').join(',');
            const [histRows] = await connection.query(
                `SELECT jovem_id, equipe
                 FROM historico_equipes
                 WHERE tenant_id = ?
                   AND jovem_id IN (${placeholders})`,
                [tenantId, ...ids]
            );
            for (const h of (histRows || [])) {
                adicionarHistoricoNoMapa(historicoMap, h.jovem_id, h.equipe);
            }
        }

        const [selecionadosOutroRows] = await connection.query(
            `SELECT oes.id, oes.jovem_id, oes.nome_externo, oes.telefone_externo, oes.outro_ejc_id, j.sexo
             FROM montagem_outro_ejc_servir oes
             LEFT JOIN jovens j ON j.id = oes.jovem_id
             WHERE montagem_id = ?
               AND pode_servir = 1
               AND COALESCE(destino, 'titular') = ?`,
            [montagemId, destino]
        );
        const outrosSelecionados = (selecionadosOutroRows || []).map((row) => ({
            id: Number(row.id) || null,
            jovem_id: Number(row.jovem_id) || null,
            nome_externo: row.nome_externo || '',
            telefone_externo: row.telefone_externo || '',
            outro_ejc_id: Number(row.outro_ejc_id) || null,
            sexo: row.sexo || null
        }));
        const idsFamilia = new Set();
        selecionados.forEach((item) => idsFamilia.add(Number(item.id) || 0));
        outrosSelecionados.forEach((item) => {
            if (item.jovem_id) idsFamilia.add(Number(item.jovem_id));
        });
        alocadosRows.forEach((item) => {
            if (item.jovem_id) idsFamilia.add(Number(item.jovem_id));
        });
        const mapaFamilia = await buildYoungFamilyMap(tenantId, Array.from(idsFamilia));
        const outroSelecionadoPorCasalKey = new Map();
        for (const item of outrosSelecionados) {
            const casalKey = obterChaveCasalOutroItem(item);
            if (!casalKey) continue;
            if (!outroSelecionadoPorCasalKey.has(casalKey)) outroSelecionadoPorCasalKey.set(casalKey, []);
            outroSelecionadoPorCasalKey.get(casalKey).push(item);
        }

        const jovemSelecionadoPorCasalKey = new Map();
        for (const item of selecionados) {
            const casalKey = obterChaveCasalJovem(item);
            if (!casalKey) continue;
            if (!jovemSelecionadoPorCasalKey.has(casalKey)) jovemSelecionadoPorCasalKey.set(casalKey, []);
            jovemSelecionadoPorCasalKey.get(casalKey).push(item);
        }

        const assignedCount = new Map();
        equipes.forEach(eq => assignedCount.set(eq.id, { total: 0, homens: 0, mulheres: 0 }));
        for (const row of (alocadosRows || [])) {
            const equipeId = Number(row.equipe_id) || 0;
            if (!assignedCount.has(equipeId)) continue;
            const atual = assignedCount.get(equipeId) || { total: 0, homens: 0, mulheres: 0 };
            if (Number(row.tio_casal_id) > 0 && !row.jovem_id) {
                atual.total += 2;
                atual.homens += 1;
                atual.mulheres += 1;
            } else {
                atual.total += 1;
                const sexo = normalizarSexo(row.sexo);
                if (sexo === 'masculino') atual.homens += 1;
                if (sexo === 'feminino') atual.mulheres += 1;
            }
            assignedCount.set(equipeId, atual);
        }

        const shuffle = (arr) => {
            const a = arr.slice();
            for (let i = a.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [a[i], a[j]] = [a[j], a[i]];
            }
            return a;
        };

        const distribuicoes = [];
        const alocadosEmEquipeAleatoria = [];
        const sem_equipe = [];
        const lista = shuffle(pendentes);
        const jovensProcessados = new Set();
        const outrosProcessados = new Set();

        await connection.beginTransaction();
        for (const jovem of lista) {
            if (jovensProcessados.has(jovem.id)) continue;

            const grupo = [{ tipo: 'jovem', item: jovem }];
            const casalKey = obterChaveCasalJovem(jovem);
            if (casalKey) {
                ((jovemSelecionadoPorCasalKey.get(casalKey) || []).filter((item) => (
                    Number(item.id) !== Number(jovem.id)
                    && !jovensProcessados.has(item.id)
                    && !jaAlocados.has(item.id)
                ))).forEach((item) => grupo.push({ tipo: 'jovem', item }));

                ((outroSelecionadoPorCasalKey.get(casalKey) || []).filter((item) => {
                    const itemKey = obterChaveItemOutroEjc(item);
                    return itemKey && !outrosProcessados.has(itemKey) && !alocadoEquipePorOutroKey.has(itemKey);
                })).forEach((item) => grupo.push({ tipo: 'outro', item }));
            }

            let equipeFixadaId = null;
            if (jovem.conjuge_id && alocadoEquipePorJovemId.has(jovem.conjuge_id)) {
                equipeFixadaId = alocadoEquipePorJovemId.get(jovem.conjuge_id);
            }
            if (!equipeFixadaId && casalKey) {
                const parceiroJaAlocado = (outroSelecionadoPorCasalKey.get(casalKey) || []).find((item) => {
                    const itemKey = obterChaveItemOutroEjc(item);
                    return itemKey && alocadoEquipePorOutroKey.has(itemKey);
                });
                if (parceiroJaAlocado) {
                    equipeFixadaId = alocadoEquipePorOutroKey.get(obterChaveItemOutroEjc(parceiroJaAlocado));
                }
            }

            let elegiveis = equipeFixadaId
                ? equipes.filter((eq) => Number(eq.id) === Number(equipeFixadaId))
                : equipes.slice();

            const historicoGrupo = new Set();
            grupo.forEach(({ tipo, item }) => {
                if (tipo !== 'jovem') return;
                (historicoMap.get(item.id) || new Set()).forEach((equipe) => historicoGrupo.add(equipe));
            });

            if (!equipeFixadaId) {
                const semHistorico = elegiveis.filter((eq) => !historicoGrupo.has(String(eq.nome || '').trim().toLowerCase()));
                if (semHistorico.length) {
                    elegiveis = semHistorico;
                } else {
                    elegiveis = equipes.slice();
                    grupo.forEach(({ tipo, item }) => {
                        alocadosEmEquipeAleatoria.push(
                            tipo === 'jovem'
                                ? (item.nome || `jovem ${item.id}`)
                                : (item.nome_externo || `jovem ${item.jovem_id || item.id}`)
                        );
                    });
                }
            }

            const totaisGrupo = contarSexosDoGrupo(grupo);
            const equipesFamiliaBloqueadas = equipesBloqueadasPorFamilia(grupo, mapaFamilia, alocadoEquipePorJovemId);
            if (equipesFamiliaBloqueadas.size) {
                elegiveis = elegiveis.filter((eq) => !equipesFamiliaBloqueadas.has(Number(eq.id)));
            }
            elegiveis = elegiveis.filter((eq) => equipeComportaGrupo(eq, assignedCount.get(eq.id), totaisGrupo));
            if (!elegiveis.length) {
                grupo.forEach(({ tipo, item }) => {
                    sem_equipe.push(
                        tipo === 'jovem'
                            ? (item.nome || `jovem ${item.id}`)
                            : (item.nome_externo || `jovem ${item.jovem_id || item.id}`)
                    );
                });
                continue;
            }

            const minCount = Math.min(...elegiveis.map(eq => (assignedCount.get(eq.id) || { total: 0 }).total));
            const candidatos = elegiveis.filter(eq => ((assignedCount.get(eq.id) || { total: 0 }).total) === minCount);
            const escolhido = candidatos[Math.floor(Math.random() * candidatos.length)];
            if (!escolhido) continue;

            for (const membro of grupo) {
                if (membro.tipo === 'jovem') {
                    const item = membro.item;
                    await connection.query(
                        `INSERT INTO montagem_membros (tenant_id, montagem_id, equipe_id, funcao_id, jovem_id, eh_substituicao)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        [tenantId, montagemId, escolhido.id, escolhido.funcao_id, item.id, ehSubstituicao]
                    );
                    if (!ehSubstituicao) {
                        await sincronizarHistoricoDaAlocacao({
                            montagemId,
                            equipeId: escolhido.id,
                            funcaoId: escolhido.funcao_id,
                            jovemId: item.id,
                            tenantId
                        });
                    }
                    jovensProcessados.add(item.id);
                    jaAlocados.add(item.id);
                    alocadoEquipePorJovemId.set(item.id, escolhido.id);
                    distribuicoes.push({ jovem_id: item.id, equipe_id: escolhido.id });
                } else {
                    const item = membro.item;
                    if (item.jovem_id) {
                        await connection.query(
                            `INSERT INTO montagem_membros (tenant_id, montagem_id, equipe_id, funcao_id, jovem_id, eh_substituicao)
                             VALUES (?, ?, ?, ?, ?, ?)`,
                            [tenantId, montagemId, escolhido.id, escolhido.funcao_id, item.jovem_id, ehSubstituicao]
                        );
                        alocadoEquipePorJovemId.set(Number(item.jovem_id), escolhido.id);
                    } else {
                        await connection.query(
                            `INSERT INTO montagem_membros (tenant_id, montagem_id, equipe_id, funcao_id, jovem_id, eh_substituicao, nome_externo, telefone_externo)
                             VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
                            [tenantId, montagemId, escolhido.id, escolhido.funcao_id, ehSubstituicao, item.nome_externo || null, item.telefone_externo || null]
                        );
                    }
                    const itemKey = obterChaveItemOutroEjc(item);
                    if (itemKey) {
                        outrosProcessados.add(itemKey);
                        alocadoEquipePorOutroKey.set(itemKey, escolhido.id);
                    }
                    distribuicoes.push({ jovem_id: item.jovem_id || null, equipe_id: escolhido.id });
                }
            }

            const atualEquipe = assignedCount.get(escolhido.id) || { total: 0, homens: 0, mulheres: 0 };
            atualEquipe.total += totaisGrupo.total;
            atualEquipe.homens += totaisGrupo.homens;
            atualEquipe.mulheres += totaisGrupo.mulheres;
            assignedCount.set(escolhido.id, atualEquipe);
        }
        await connection.commit();

        return res.json({
            message: 'Distribuição concluída.',
            distribuidos: distribuicoes.length,
            ignorados: selecionados.length - pendentes.length,
            sem_equipe,
            alocados_em_equipe_aleatoria: alocadosEmEquipeAleatoria
        });
    } catch (err) {
        try { await connection.rollback(); } catch (_) { }
        console.error('Erro ao distribuir jovens:', err);
        return res.status(500).json({ error: 'Erro ao distribuir jovens.' });
    } finally {
        connection.release();
    }
});

router.post('/:id/tios-servir/distribuir', async (req, res) => {
    const montagemId = Number(req.params.id);
    if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
    const excluirEquipes = Array.isArray(req.body && req.body.excluir_equipes) ? req.body.excluir_equipes : [];
    const excluirSet = new Set(excluirEquipes.map((e) => Number(e)).filter(Boolean));
    try {
        await garantirEstruturaMontagemTiosServir();
        const tenantId = getTenantId(req);
        const destino = normalizarDestinoSelecao(req.body && req.body.destino);
        const ehSubstituicao = destino === 'reserva' ? 1 : 0;
        const [selecionadosRows] = await pool.query(
            `SELECT c.id, c.nome_tio, c.nome_tia, c.telefone_tio, c.telefone_tia
             FROM montagem_tios_servir mts
             JOIN tios_casais c ON c.id = mts.casal_id
             WHERE mts.montagem_id = ?
               AND mts.pode_servir = 1
               AND COALESCE(mts.destino, 'titular') = ?
               AND c.tenant_id = ?
             ORDER BY c.nome_tio ASC, c.nome_tia ASC`,
            [montagemId, destino, tenantId]
        );
        if (!selecionadosRows.length) {
            return res.status(400).json({ error: 'Nenhum casal de tios selecionado para servir.' });
        }

        const comPapelBase = await hasPapelBaseColumn();
        const papelBaseSelect = comPapelBase ? 'COALESCE(ef.papel_base, "Membro")' : '"Membro"';
        const [equipesFuncoes] = await pool.query(`
            SELECT eq.id as equipe_id, eq.nome as equipe_nome,
                   ef.id as funcao_id, ef.nome as funcao_nome, ${papelBaseSelect} as papel_base
            FROM equipes eq
            LEFT JOIN equipes_funcoes ef ON eq.id = ef.equipe_id
                                        AND ef.tenant_id = eq.tenant_id
            WHERE eq.tenant_id = ?
            ORDER BY eq.nome ASC, ef.nome ASC
        `, [tenantId]);

        const equipeMap = new Map();
        for (const row of (equipesFuncoes || [])) {
            if (excluirSet.has(Number(row.equipe_id))) continue;
            if (!equipeMap.has(row.equipe_id)) {
                equipeMap.set(row.equipe_id, { id: row.equipe_id, nome: row.equipe_nome || '', funcoes: [] });
            }
            if (row.funcao_id) {
                equipeMap.get(row.equipe_id).funcoes.push({
                    id: row.funcao_id,
                    nome: row.funcao_nome || '',
                    papel_base: row.papel_base || 'Membro'
                });
            }
        }

        const equipes = Array.from(equipeMap.values()).map((eq) => {
            let funcaoId = null;
            if (eq.funcoes.length) {
                const funcaoTio = eq.funcoes.find(f => String(f.papel_base || '').toLowerCase() === 'tio')
                    || eq.funcoes.find(f => String(f.nome || '').toLowerCase().includes('tio'))
                    || eq.funcoes.find(f => String(f.nome || '').toLowerCase().includes('tia'))
                    || null;
                funcaoId = funcaoTio ? funcaoTio.id : null;
            }
            return { ...eq, funcao_id: funcaoId };
        }).filter(eq => !!eq.funcao_id);

        if (!equipes.length) {
            return res.status(400).json({ error: 'Nenhuma equipe com função de tio encontrada.' });
        }

        const casalIds = selecionadosRows.map((c) => c.id);
        const servicosMap = new Map();
        if (await hasTable('tios_casal_servicos')) {
            const placeholders = casalIds.map(() => '?').join(',');
            const [servRows] = await pool.query(
                `SELECT casal_id, equipe_id FROM tios_casal_servicos WHERE casal_id IN (${placeholders})`,
                casalIds
            );
            for (const r of (servRows || [])) {
                if (!servicosMap.has(r.casal_id)) servicosMap.set(r.casal_id, new Set());
                servicosMap.get(r.casal_id).add(Number(r.equipe_id));
            }
        }

        let distribuidos = 0;
        const jaAlocados = [];
        for (const casal of selecionadosRows) {
            const nomeCasal = `${casal.nome_tio || ''} e ${casal.nome_tia || ''}`.trim();
            if (!nomeCasal) continue;

            const [existente] = await pool.query(
                `SELECT id FROM montagem_membros WHERE montagem_id = ? AND tenant_id = ? AND nome_externo = ? LIMIT 1`,
                [montagemId, tenantId, nomeCasal]
            );
            if (existente.length) {
                jaAlocados.push(nomeCasal);
                continue;
            }

            const servidos = servicosMap.get(casal.id) || new Set();
            let disponiveis = equipes.filter(eq => !servidos.has(Number(eq.id)));
            if (!disponiveis.length) disponiveis = equipes;
            const escolhido = disponiveis[Math.floor(Math.random() * disponiveis.length)];
            if (!escolhido) continue;

            await pool.query(
                `INSERT INTO montagem_membros (tenant_id, montagem_id, equipe_id, funcao_id, jovem_id, eh_substituicao, nome_externo, telefone_externo)
                 VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
                [tenantId, montagemId, escolhido.id, escolhido.funcao_id, ehSubstituicao, nomeCasal, montarTelefoneCasal(casal.telefone_tio, casal.telefone_tia)]
            );
            distribuidos += 1;
        }

        return res.json({ message: 'Distribuição concluída.', distribuidos, ja_alocados: jaAlocados });
    } catch (err) {
        console.error('Erro ao distribuir tios:', err);
        return res.status(500).json({ error: 'Erro ao distribuir tios.' });
    }
});

router.post('/:id/outro-ejc-servir/distribuir', async (req, res) => {
    const montagemId = Number(req.params.id);
    if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
    const excluirEquipes = Array.isArray(req.body && req.body.excluir_equipes) ? req.body.excluir_equipes : [];
    const excluirSet = new Set(excluirEquipes.map((e) => Number(e)).filter(Boolean));
    try {
        await garantirEstruturaMontagemOutroEjcServir();
        await ensureEquipeSexoLimitsColumns();
        const tenantId = getTenantId(req);
        const destino = normalizarDestinoSelecao(req.body && req.body.destino);
        const ehSubstituicao = destino === 'reserva' ? 1 : 0;
        const hasConjugeId = await hasColumn('jovens', 'conjuge_id');
        const hasConjugeNome = await hasColumn('jovens', 'conjuge_nome');
        const hasConjugeOutroEjcId = await hasColumn('jovens', 'conjuge_outro_ejc_id');
        const [selecionados] = await pool.query(
            `SELECT oes.id, oes.jovem_id, oes.nome_externo, oes.telefone_externo, oes.outro_ejc_id,
                    j.sexo,
                    ${hasConjugeId ? 'j.conjuge_id' : 'NULL AS conjuge_id'},
                    ${hasConjugeNome ? 'j.conjuge_nome' : 'NULL AS conjuge_nome'},
                    ${hasConjugeOutroEjcId ? 'j.conjuge_outro_ejc_id' : 'NULL AS conjuge_outro_ejc_id'}
             FROM montagem_outro_ejc_servir oes
             LEFT JOIN jovens j ON j.id = oes.jovem_id
             WHERE oes.montagem_id = ? AND oes.pode_servir = 1 AND COALESCE(oes.destino, 'titular') = ?`,
            [montagemId, destino]
        );
        if (!selecionados.length) {
            return res.status(400).json({ error: 'Nenhum jovem de outro EJC selecionado para servir.' });
        }

        const comPapelBase = await hasPapelBaseColumn();
        const papelBaseSelect = comPapelBase ? 'COALESCE(ef.papel_base, "Membro")' : '"Membro"';
        const [equipesFuncoes] = await pool.query(`
            SELECT eq.id as equipe_id, eq.nome as equipe_nome, COALESCE(eq.membros_outro_ejc, 0) AS membros_outro_ejc,
                   eq.limite_homens, eq.limite_mulheres,
                   ef.id as funcao_id, ef.nome as funcao_nome, ${papelBaseSelect} as papel_base
            FROM equipes eq
            LEFT JOIN equipes_funcoes ef ON eq.id = ef.equipe_id
            ORDER BY eq.nome ASC, ef.nome ASC
        `);
        const equipeMap = new Map();
        for (const row of (equipesFuncoes || [])) {
            if (excluirSet.has(Number(row.equipe_id))) continue;
            if (!equipeMap.has(row.equipe_id)) {
                equipeMap.set(row.equipe_id, {
                    id: row.equipe_id,
                    nome: row.equipe_nome || '',
                    membros_outro_ejc: Number(row.membros_outro_ejc || 0) === 1,
                    limite_homens: row.limite_homens === null ? null : Number(row.limite_homens),
                    limite_mulheres: row.limite_mulheres === null ? null : Number(row.limite_mulheres),
                    funcoes: []
                });
            }
            if (row.funcao_id) {
                equipeMap.get(row.equipe_id).funcoes.push({
                    id: row.funcao_id,
                    nome: row.funcao_nome || '',
                    papel_base: row.papel_base || 'Membro'
                });
            }
        }
        const equipesBase = Array.from(equipeMap.values()).map((eq) => {
            let funcaoId = null;
            if (eq.funcoes.length) {
                const membro = eq.funcoes.find(f => String(f.papel_base || '').toLowerCase() === 'membro')
                    || eq.funcoes.find(f => String(f.nome || '').toLowerCase().includes('membro'))
                    || eq.funcoes[0];
                funcaoId = membro ? membro.id : null;
            }
            return { ...eq, funcao_id: funcaoId };
        }).filter(eq => !!eq.funcao_id);
        const equipesMarcadasOutro = equipesBase.filter(eq => eq.membros_outro_ejc);
        const equipes = equipesMarcadasOutro.length ? equipesMarcadasOutro : equipesBase;

        if (!equipes.length) {
            return res.status(400).json({ error: 'Nenhuma equipe com função disponível para distribuição.' });
        }

        const jovemIds = selecionados.map(s => Number(s.jovem_id)).filter(Boolean);
        const historicoMap = new Map();
        if (jovemIds.length && await hasTable('historico_equipes')) {
            const placeholders = jovemIds.map(() => '?').join(',');
            const [histRows] = await pool.query(
                `SELECT jovem_id, equipe FROM historico_equipes
                 WHERE tenant_id = ? AND jovem_id IN (${placeholders})`,
                [tenantId, ...jovemIds]
            );
            for (const h of (histRows || [])) {
                adicionarHistoricoNoMapa(historicoMap, h.jovem_id, h.equipe);
            }
        }

        const [alocados] = await pool.query(
            `SELECT mm.equipe_id, mm.jovem_id, mm.nome_externo, mm.telefone_externo, j.sexo,
                    tc.id AS tio_casal_id
             FROM montagem_membros mm
             LEFT JOIN jovens j ON j.id = mm.jovem_id
             LEFT JOIN tios_casais tc
               ON tc.tenant_id = mm.tenant_id
              AND TRIM(CONCAT(COALESCE(tc.nome_tio, ''), ' e ', COALESCE(tc.nome_tia, ''))) = TRIM(COALESCE(mm.nome_externo, ''))
             WHERE mm.montagem_id = ? AND mm.tenant_id = ?`,
            [montagemId, tenantId]
        );
        const jaAlocadosIds = new Set(alocados.map(a => Number(a.jovem_id)).filter(Boolean));
        const jaAlocadosNomes = new Set(alocados.map(a => String(a.nome_externo || '').trim().toLowerCase()).filter(Boolean));
        const alocadoEquipePorJovemId = new Map();
        const alocadoEquipePorOutroKey = new Map();
        alocados.forEach((item) => {
            const jovemId = Number(item.jovem_id) || 0;
            const equipeId = Number(item.equipe_id) || 0;
            if (jovemId > 0 && equipeId > 0) alocadoEquipePorJovemId.set(jovemId, equipeId);
            const itemKey = obterChaveItemOutroEjc(item);
            if (itemKey && equipeId > 0) alocadoEquipePorOutroKey.set(itemKey, equipeId);
        });
        const assignedCount = new Map();
        equipes.forEach((eq) => assignedCount.set(eq.id, { total: 0, homens: 0, mulheres: 0 }));
        alocados.forEach((item) => {
            const equipeId = Number(item.equipe_id) || 0;
            if (!assignedCount.has(equipeId)) return;
            const atual = assignedCount.get(equipeId) || { total: 0, homens: 0, mulheres: 0 };
            if (Number(item.tio_casal_id) > 0 && !item.jovem_id) {
                atual.total += 2;
                atual.homens += 1;
                atual.mulheres += 1;
            } else {
                atual.total += 1;
                const sexo = normalizarSexo(item.sexo);
                if (sexo === 'masculino') atual.homens += 1;
                if (sexo === 'feminino') atual.mulheres += 1;
            }
            assignedCount.set(equipeId, atual);
        });

        const [origemSelecionadosRows] = await pool.query(
            `SELECT j.id, j.nome_completo, j.sexo,
                    ${hasConjugeId ? 'j.conjuge_id' : 'NULL AS conjuge_id'},
                    ${hasConjugeNome ? 'j.conjuge_nome' : 'NULL AS conjuge_nome'},
                    ${hasConjugeOutroEjcId ? 'j.conjuge_outro_ejc_id' : 'NULL AS conjuge_outro_ejc_id'}
             FROM montagem_jovens_servir mjs
             JOIN jovens j ON j.id = mjs.jovem_id
             WHERE mjs.montagem_id = ?
               AND mjs.pode_servir = 1
               AND COALESCE(mjs.destino, 'titular') = ?
               AND j.tenant_id = ?`,
            [montagemId, destino, tenantId]
        );
        const origemSelecionadosPorCasalKey = new Map();
        (origemSelecionadosRows || []).forEach((item) => {
            const casalKey = obterChaveCasalJovem(item);
            if (!casalKey) return;
            if (!origemSelecionadosPorCasalKey.has(casalKey)) origemSelecionadosPorCasalKey.set(casalKey, []);
            origemSelecionadosPorCasalKey.get(casalKey).push(item);
        });

        const outroSelecionadoPorCasalKey = new Map();
        (selecionados || []).forEach((item) => {
            const casalKey = obterChaveCasalOutroItem(item);
            if (!casalKey) return;
            if (!outroSelecionadoPorCasalKey.has(casalKey)) outroSelecionadoPorCasalKey.set(casalKey, []);
            outroSelecionadoPorCasalKey.get(casalKey).push(item);
        });
        const idsFamilia = new Set();
        (selecionados || []).forEach((item) => {
            if (item.jovem_id) idsFamilia.add(Number(item.jovem_id));
        });
        (origemSelecionadosRows || []).forEach((item) => idsFamilia.add(Number(item.id) || 0));
        (alocados || []).forEach((item) => {
            if (item.jovem_id) idsFamilia.add(Number(item.jovem_id));
        });
        const mapaFamilia = await buildYoungFamilyMap(tenantId, Array.from(idsFamilia));

        let distribuidos = 0;
        let semEquipe = [];
        const outrosProcessados = new Set();
        for (const item of selecionados) {
            const jovemId = Number(item.jovem_id) || null;
            const nome = String(item.nome_externo || '').trim();
            const telefone = String(item.telefone_externo || '').trim() || null;
            const itemKey = obterChaveItemOutroEjc(item);
            if (itemKey && outrosProcessados.has(itemKey)) continue;
            if (jovemId && jaAlocadosIds.has(jovemId)) continue;
            if (!jovemId && nome && jaAlocadosNomes.has(nome.toLowerCase())) continue;

            const grupo = [{ tipo: 'outro', item }];
            const casalKey = obterChaveCasalOutroItem(item);
            if (casalKey) {
                ((outroSelecionadoPorCasalKey.get(casalKey) || []).filter((outro) => {
                    const outroKey = obterChaveItemOutroEjc(outro);
                    return outroKey && outroKey !== itemKey && !outrosProcessados.has(outroKey) && !alocadoEquipePorOutroKey.has(outroKey);
                })).forEach((outro) => grupo.push({ tipo: 'outro', item: outro }));

                ((origemSelecionadosPorCasalKey.get(casalKey) || []).filter((origem) => !jaAlocadosIds.has(Number(origem.id) || 0)))
                    .forEach((origem) => grupo.push({ tipo: 'jovem', item: origem }));
            }

            let equipeFixadaId = null;
            if (jovemId && item.conjuge_id && alocadoEquipePorJovemId.has(Number(item.conjuge_id))) {
                equipeFixadaId = alocadoEquipePorJovemId.get(Number(item.conjuge_id));
            }
            if (!equipeFixadaId && casalKey) {
                const origemAlocado = (origemSelecionadosPorCasalKey.get(casalKey) || []).find((origem) => alocadoEquipePorJovemId.has(Number(origem.id)));
                if (origemAlocado) {
                    equipeFixadaId = alocadoEquipePorJovemId.get(Number(origemAlocado.id));
                }
            }

            let disponiveis = equipeFixadaId
                ? equipes.filter((eq) => Number(eq.id) === Number(equipeFixadaId))
                : equipes.slice();

            const historicoGrupo = new Set();
            grupo.forEach(({ tipo, item: membro }) => {
                if (tipo !== 'jovem') return;
                (historicoMap.get(Number(membro.id) || 0) || new Set()).forEach((equipe) => historicoGrupo.add(equipe));
            });
            if (jovemId && historicoMap.has(jovemId)) {
                (historicoMap.get(jovemId) || new Set()).forEach((equipe) => historicoGrupo.add(equipe));
            }
            if (!equipeFixadaId) {
                const semHistorico = disponiveis.filter(eq => !historicoGrupo.has(String(eq.nome || '').toLowerCase()));
                if (semHistorico.length) disponiveis = semHistorico;
            }
            const totaisGrupo = contarSexosDoGrupo(grupo);
            const equipesFamiliaBloqueadas = equipesBloqueadasPorFamilia(grupo, mapaFamilia, alocadoEquipePorJovemId);
            if (equipesFamiliaBloqueadas.size) {
                disponiveis = disponiveis.filter((eq) => !equipesFamiliaBloqueadas.has(Number(eq.id)));
            }
            disponiveis = disponiveis.filter((eq) => equipeComportaGrupo(eq, assignedCount.get(eq.id), totaisGrupo));
            if (!disponiveis.length) {
                semEquipe.push(nome || `jovem ${jovemId}`);
                continue;
            }
            const escolhido = disponiveis[Math.floor(Math.random() * disponiveis.length)];
            if (!escolhido) continue;

            for (const membro of grupo) {
                if (membro.tipo === 'jovem') {
                    const origem = membro.item;
                    await pool.query(
                        `INSERT INTO montagem_membros (tenant_id, montagem_id, equipe_id, funcao_id, jovem_id, eh_substituicao)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        [tenantId, montagemId, escolhido.id, escolhido.funcao_id, origem.id, ehSubstituicao]
                    );
                    if (!ehSubstituicao) {
                        await sincronizarHistoricoDaAlocacao({
                            montagemId,
                            equipeId: escolhido.id,
                            funcaoId: escolhido.funcao_id,
                            jovemId: origem.id,
                            tenantId
                        });
                    }
                    jaAlocadosIds.add(Number(origem.id));
                    alocadoEquipePorJovemId.set(Number(origem.id), escolhido.id);
                    distribuidos += 1;
                } else {
                    const outro = membro.item;
                    const outroJovemId = Number(outro.jovem_id) || null;
                    const outroNome = String(outro.nome_externo || '').trim();
                    const outroTelefone = String(outro.telefone_externo || '').trim() || null;
                    if (outroJovemId) {
                        await pool.query(
                            `INSERT INTO montagem_membros (tenant_id, montagem_id, equipe_id, funcao_id, jovem_id, eh_substituicao)
                             VALUES (?, ?, ?, ?, ?, ?)`,
                            [tenantId, montagemId, escolhido.id, escolhido.funcao_id, outroJovemId, ehSubstituicao]
                        );
                        jaAlocadosIds.add(outroJovemId);
                        alocadoEquipePorJovemId.set(outroJovemId, escolhido.id);
                    } else {
                        await pool.query(
                            `INSERT INTO montagem_membros (tenant_id, montagem_id, equipe_id, funcao_id, jovem_id, eh_substituicao, nome_externo, telefone_externo)
                             VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
                            [tenantId, montagemId, escolhido.id, escolhido.funcao_id, ehSubstituicao, outroNome, outroTelefone]
                        );
                        if (outroNome) jaAlocadosNomes.add(outroNome.toLowerCase());
                    }
                    const outroKey = obterChaveItemOutroEjc(outro);
                    if (outroKey) {
                        outrosProcessados.add(outroKey);
                        alocadoEquipePorOutroKey.set(outroKey, escolhido.id);
                    }
                    distribuidos += 1;
                }
            }
            const atualEquipe = assignedCount.get(escolhido.id) || { total: 0, homens: 0, mulheres: 0 };
            atualEquipe.total += totaisGrupo.total;
            atualEquipe.homens += totaisGrupo.homens;
            atualEquipe.mulheres += totaisGrupo.mulheres;
            assignedCount.set(escolhido.id, atualEquipe);
        }

        return res.json({ message: 'Distribuição concluída.', distribuidos, sem_equipe: semEquipe });
    } catch (err) {
        console.error('Erro ao distribuir jovens de outro EJC:', err);
        return res.status(500).json({ error: 'Erro ao distribuir jovens de outro EJC.' });
    }
});

router.patch('/:id/jovens-para-servir/:jovemId', async (req, res) => {
    const montagemId = Number(req.params.id);
    const jovemId = Number(req.params.jovemId);
    const podeServir = req.body && req.body.pode_servir ? 1 : 0;
    if (!montagemId || !jovemId) return res.status(400).json({ error: 'Parâmetros inválidos.' });
    try {
        await garantirEstruturaMontagemJovensServir();
        const [jovemRows] = await pool.query('SELECT id FROM jovens WHERE id = ? LIMIT 1', [jovemId]);
        if (!jovemRows.length) return res.status(404).json({ error: 'Jovem não encontrado.' });

        await pool.query(
            `INSERT INTO montagem_jovens_servir (montagem_id, jovem_id, pode_servir)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE pode_servir = VALUES(pode_servir)`,
            [montagemId, jovemId, podeServir]
        );
        return res.json({ message: 'Lista de jovens para servir atualizada.' });
    } catch (err) {
        console.error('Erro ao atualizar jovem para servir:', err);
        return res.status(500).json({ error: 'Erro ao atualizar lista de jovens para servir.' });
    }
});

router.get('/:id/tios-para-servir', async (req, res) => {
    const montagemId = Number(req.params.id);
    if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
    try {
        await garantirEstruturaMontagemTiosServir();
        const tenantId = getTenantId(req);
        const [rows] = await pool.query(`
            SELECT
                c.id,
                c.origem_tipo,
                c.outro_ejc_id,
                c.nome_tio,
                c.nome_tia,
                c.telefone_tio,
                c.telefone_tia,
                oe.nome AS outro_ejc_nome,
                oe.paroquia AS outro_ejc_paroquia,
                COALESCE(mts.pode_servir, 0) AS pode_servir,
                COALESCE(mts.destino, 'titular') AS destino
            FROM tios_casais c
            LEFT JOIN outros_ejcs oe ON oe.id = c.outro_ejc_id AND oe.tenant_id = c.tenant_id
            LEFT JOIN montagem_tios_servir mts ON mts.casal_id = c.id AND mts.montagem_id = ?
            LEFT JOIN montagem_membros mm
              ON mm.montagem_id = ?
             AND mm.tenant_id = c.tenant_id
             AND mm.jovem_id IS NULL
             AND TRIM(COALESCE(mm.nome_externo, '')) = TRIM(CONCAT(COALESCE(c.nome_tio, ''), ' e ', COALESCE(c.nome_tia, '')))
            WHERE c.tenant_id = ?
              AND mm.id IS NULL
            ORDER BY c.nome_tio ASC, c.nome_tia ASC
        `, [montagemId, montagemId, tenantId]);
        const casalIds = (rows || []).map((r) => Number(r.id)).filter((id) => id > 0);
        if (!casalIds.length || !(await hasTable('tios_casal_servicos'))) {
            return res.json(rows || []);
        }

        const placeholders = casalIds.map(() => '?').join(',');
        const [servicosRows] = await pool.query(
            `SELECT
                ts.casal_id,
                ts.equipe_id,
                eq.nome AS equipe_nome,
                ts.ejc_id,
                e.numero AS ejc_numero,
                e.paroquia AS ejc_paroquia
             FROM tios_casal_servicos ts
             JOIN equipes eq ON eq.id = ts.equipe_id AND eq.tenant_id = ts.tenant_id
             LEFT JOIN ejc e ON e.id = ts.ejc_id AND e.tenant_id = ts.tenant_id
             WHERE ts.tenant_id = ?
               AND ts.casal_id IN (${placeholders})
             ORDER BY e.numero DESC, eq.nome ASC`,
            [tenantId, ...casalIds]
        );

        const historicoByCasal = new Map();
        for (const row of (servicosRows || [])) {
            const casalId = Number(row.casal_id);
            if (!casalId) continue;
            if (!historicoByCasal.has(casalId)) historicoByCasal.set(casalId, []);
            historicoByCasal.get(casalId).push({
                equipe_id: Number(row.equipe_id) || null,
                equipe_nome: row.equipe_nome || '',
                ejc_id: row.ejc_id ? Number(row.ejc_id) : null,
                ejc_numero: row.ejc_numero ? Number(row.ejc_numero) : null,
                ejc_paroquia: row.ejc_paroquia || null
            });
        }

        const payload = (rows || []).map((row) => ({
            ...row,
            historico_equipes: historicoByCasal.get(Number(row.id)) || []
        }));
        return res.json(payload);
    } catch (err) {
        console.error('Erro ao listar tios para servir:', err);
        return res.status(500).json({ error: 'Erro ao listar tios para servir.' });
    }
});

router.patch('/:id/tios-para-servir/:casalId', async (req, res) => {
    const montagemId = Number(req.params.id);
    const casalId = Number(req.params.casalId);
    const podeServir = req.body && req.body.pode_servir ? 1 : 0;
    if (!montagemId || !casalId) return res.status(400).json({ error: 'Parâmetros inválidos.' });
    try {
        await garantirEstruturaMontagemTiosServir();
        const tenantId = getTenantId(req);
        const [casalRows] = await pool.query(
            'SELECT id FROM tios_casais WHERE id = ? AND tenant_id = ? LIMIT 1',
            [casalId, tenantId]
        );
        if (!casalRows.length) return res.status(404).json({ error: 'Casal de tios não encontrado.' });

        await pool.query(
            `INSERT INTO montagem_tios_servir (montagem_id, casal_id, pode_servir)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE pode_servir = VALUES(pode_servir)`,
            [montagemId, casalId, podeServir]
        );
        return res.json({ message: 'Lista de tios para servir atualizada.' });
    } catch (err) {
        console.error('Erro ao atualizar tio para servir:', err);
        return res.status(500).json({ error: 'Erro ao atualizar lista de tios para servir.' });
    }
});

router.post('/:id/tios-para-servir/selecionar', async (req, res) => {
    const montagemId = Number(req.params.id);
    if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
    try {
        await garantirEstruturaMontagemTiosServir();
        const tenantId = getTenantId(req);
        const itens = Array.isArray(req.body && req.body.itens) ? req.body.itens : null;
        if (itens) {
            await pool.query('DELETE FROM montagem_tios_servir WHERE montagem_id = ?', [montagemId]);
            const values = itens
                .map((item) => ({
                    casalId: Number(item && item.id),
                    podeServir: item && item.selecionado ? 1 : 0,
                    destino: normalizarDestinoSelecao(item && item.destino)
                }))
                .filter((item) => item.casalId > 0);
            if (values.length) {
                await pool.query(
                    `INSERT INTO montagem_tios_servir (montagem_id, casal_id, pode_servir, destino)
                     VALUES ?`,
                    [values.map((item) => [montagemId, item.casalId, item.podeServir, item.destino])]
                );
            }
        } else {
            const selecionados = Array.isArray(req.body && req.body.casal_ids) ? req.body.casal_ids : [];
            const ids = selecionados.map((v) => Number(v)).filter((v) => v > 0);
            await pool.query('UPDATE montagem_tios_servir SET pode_servir = 0 WHERE montagem_id = ?', [montagemId]);
            if (ids.length) {
                const values = ids.map((id) => [montagemId, id, 1, 'titular']);
                await pool.query(
                    `INSERT INTO montagem_tios_servir (montagem_id, casal_id, pode_servir, destino)
                     VALUES ?
                     ON DUPLICATE KEY UPDATE pode_servir = VALUES(pode_servir), destino = VALUES(destino)`,
                    [values]
                );
            }
        }
        // remove registros que não pertencem mais ao tenant
        await pool.query(
            `DELETE mts FROM montagem_tios_servir mts
             LEFT JOIN tios_casais tc ON tc.id = mts.casal_id
             WHERE mts.montagem_id = ? AND (tc.id IS NULL OR tc.tenant_id <> ?)`,
            [montagemId, tenantId]
        );
        return res.json({ message: 'Seleção de tios atualizada.' });
    } catch (err) {
        console.error('Erro ao salvar seleção de tios:', err);
        return res.status(500).json({ error: 'Erro ao salvar seleção de tios.' });
    }
});

router.get('/:id/outro-ejc-servir', async (req, res) => {
    const montagemId = Number(req.params.id);
    if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
    try {
        await garantirEstruturaMontagemOutroEjcServir();
        const [rows] = await pool.query(
            `SELECT id, jovem_id, nome_externo, telefone_externo, outro_ejc_id, pode_servir, COALESCE(destino, 'titular') AS destino
             FROM montagem_outro_ejc_servir
             WHERE montagem_id = ?`,
            [montagemId]
        );
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar seleção de jovens de outro EJC:', err);
        return res.status(500).json({ error: 'Erro ao listar seleção.' });
    }
});

router.post('/:id/outro-ejc-servir/selecionar', async (req, res) => {
    const montagemId = Number(req.params.id);
    if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
    const itens = Array.isArray(req.body && req.body.itens) ? req.body.itens : [];
    try {
        await garantirEstruturaMontagemOutroEjcServir();
        await pool.query('DELETE FROM montagem_outro_ejc_servir WHERE montagem_id = ?', [montagemId]);
        const registros = itens.filter((i) => i);
        if (registros.length) {
            const values = registros.map((i) => [
                montagemId,
                i.jovem_id ? Number(i.jovem_id) : null,
                i.nome_completo ? String(i.nome_completo).trim() : (i.nome ? String(i.nome).trim() : null),
                i.telefone ? String(i.telefone).trim() : null,
                i.outro_ejc_id ? Number(i.outro_ejc_id) : null,
                i.selecionado ? 1 : 0,
                normalizarDestinoSelecao(i.destino)
            ]);
            await pool.query(
                `INSERT INTO montagem_outro_ejc_servir
                 (montagem_id, jovem_id, nome_externo, telefone_externo, outro_ejc_id, pode_servir, destino)
                 VALUES ?`,
                [values]
            );
        }
        return res.json({ message: 'Seleção de jovens de outro EJC atualizada.' });
    } catch (err) {
        console.error('Erro ao salvar seleção de jovens de outro EJC:', err);
        return res.status(500).json({ error: 'Erro ao salvar seleção.' });
    }
});

// Reuniões e presença (Pré-Encontro)
router.get('/:id/reunioes', async (req, res) => {
    const montagemId = Number(req.params.id);
    if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
    try {
        const tenantId = getTenantId(req);
        await garantirEstruturaMontagemReunioes();
        const [reunioes] = await pool.query(
            `SELECT id, data_reuniao, periodo
             FROM montagem_reunioes
             WHERE montagem_id = ?
             ORDER BY data_reuniao ASC`,
            [montagemId]
        );
        const [membros] = await pool.query(
            `SELECT mm.id AS membro_id, mm.equipe_id, e.nome AS equipe_nome,
                    mm.jovem_id,
                    COALESCE(j.id, 0) AS id,
                    COALESCE(j.nome_completo, mm.nome_externo) AS nome_completo,
                    COALESCE(j.telefone, mm.telefone_externo) AS telefone,
                    COALESCE(j.origem_ejc_tipo, 'INCONFIDENTES') AS origem_ejc_tipo,
                    j.numero_ejc_fez, j.outro_ejc_numero, j.outro_ejc_id,
                    oe.nome AS outro_ejc_nome, oe.paroquia AS outro_ejc_paroquia
             FROM montagem_membros mm
             JOIN equipes e ON e.id = mm.equipe_id
             LEFT JOIN jovens j ON j.id = mm.jovem_id
             LEFT JOIN outros_ejcs oe ON oe.id = j.outro_ejc_id
            WHERE mm.montagem_id = ?
              AND mm.tenant_id = ?
              AND mm.eh_substituicao = 0
              AND (mm.status_ligacao = 'ACEITOU')
             ORDER BY e.nome ASC, COALESCE(j.nome_completo, mm.nome_externo) ASC`,
            [montagemId, tenantId]
        );
        const [presencas] = await pool.query(
            `SELECT reuniao_id, jovem_id, membro_id, COALESCE(membro_id, jovem_id) AS membro_ref, presente
             FROM montagem_reunioes_presencas
             WHERE montagem_id = ?`,
            [montagemId]
        );
        const equipesMap = new Map();
        for (const row of membros || []) {
            const equipeId = Number(row.equipe_id);
            if (!equipesMap.has(equipeId)) {
                equipesMap.set(equipeId, { id: equipeId, nome: row.equipe_nome, membros: [] });
            }
            equipesMap.get(equipeId).membros.push({
                id: row.membro_id,
                membro_id: row.membro_id,
                jovem_id: row.jovem_id,
                nome_completo: row.nome_completo,
                telefone: row.telefone,
                origem_ejc_tipo: row.origem_ejc_tipo,
                numero_ejc_fez: row.numero_ejc_fez,
                outro_ejc_numero: row.outro_ejc_numero,
                outro_ejc_id: row.outro_ejc_id,
                outro_ejc_nome: row.outro_ejc_nome,
                outro_ejc_paroquia: row.outro_ejc_paroquia
            });
        }
        const equipes = Array.from(equipesMap.values());
        return res.json({ reunioes, equipes, presencas });
    } catch (err) {
        console.error('Erro ao buscar reuniões:', err);
        return res.status(500).json({ error: 'Erro ao buscar reuniões.' });
    }
});

router.post('/:id/reunioes/gerar', async (req, res) => {
    const montagemId = Number(req.params.id);
    if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
    try {
        await garantirEstruturaMontagemReunioes();
        const dataInicio = normalizarDataBr(req.body.data_inicio);
        const dataFim = normalizarDataBr(req.body.data_fim);
        const diaSemana = normalizarDiaSemana(req.body.dia_semana);
        const periodo = String(req.body.periodo || '').trim() || null;
        if (!dataInicio || !dataFim || diaSemana === null) {
            return res.status(400).json({ error: 'Informe período e datas válidas.' });
        }
        if (dataInicio > dataFim) {
            return res.status(400).json({ error: 'Data fim não pode ser menor que a data início.' });
        }

        const datas = gerarDatasReunioesPorDiaSemana(dataInicio, dataFim, diaSemana);
        if (!datas.length) {
            return res.status(400).json({ error: 'Nenhuma reunião encontrada dentro do período.' });
        }

        await pool.query('DELETE FROM montagem_reunioes_presencas WHERE montagem_id = ?', [montagemId]);
        await pool.query('DELETE FROM montagem_reunioes WHERE montagem_id = ?', [montagemId]);

        const values = datas.map((d) => [montagemId, d, periodo]);
        await pool.query(
            'INSERT INTO montagem_reunioes (montagem_id, data_reuniao, periodo) VALUES ?',
            [values]
        );

        return res.json({ message: 'Reuniões geradas com sucesso.', total: datas.length });
    } catch (err) {
        console.error('Erro ao gerar reuniões:', err);
        return res.status(500).json({ error: 'Erro ao gerar reuniões.' });
    }
});

router.post('/:id/reunioes/gerar-domingos', async (req, res) => {
    const montagemId = Number(req.params.id);
    if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
    try {
        await garantirEstruturaMontagemReunioes();
        const dataInicio = normalizarDataBr(req.body.data_inicio);
        const dataFim = normalizarDataBr(req.body.data_fim);
        if (!dataInicio || !dataFim) return res.status(400).json({ error: 'Informe datas válidas.' });
        if (dataInicio > dataFim) return res.status(400).json({ error: 'Data fim não pode ser menor que a data início.' });

        const datas = gerarDatasReunioesPorDiaSemana(dataInicio, dataFim, 0);
        if (!datas.length) {
            return res.status(400).json({ error: 'Nenhum domingo encontrado dentro do período.' });
        }

        await pool.query('DELETE FROM montagem_reunioes_presencas WHERE montagem_id = ?', [montagemId]);
        await pool.query('DELETE FROM montagem_reunioes WHERE montagem_id = ?', [montagemId]);

        const values = datas.map((d) => [montagemId, d, 'Domingo']);
        await pool.query(
            'INSERT INTO montagem_reunioes (montagem_id, data_reuniao, periodo) VALUES ?',
            [values]
        );

        return res.json({ message: 'Reuniões (domingos) geradas com sucesso.', total: datas.length });
    } catch (err) {
        console.error('Erro ao gerar reuniões (domingos):', err);
        return res.status(500).json({ error: 'Erro ao gerar reuniões.' });
    }
});

router.patch('/:id/reunioes/:reuniaoId/presencas/:jovemId', async (req, res) => {
    const montagemId = Number(req.params.id);
    const reuniaoId = Number(req.params.reuniaoId);
    const membroId = Number(req.params.jovemId);
    const presente = req.body && req.body.presente ? 1 : 0;
    if (!montagemId || !reuniaoId || !membroId) return res.status(400).json({ error: 'Parâmetros inválidos.' });
    try {
        await garantirEstruturaMontagemReunioes();
        const [[membro]] = await pool.query(
            `SELECT id, jovem_id
             FROM montagem_membros
             WHERE id = ? AND montagem_id = ?
             LIMIT 1`,
            [membroId, montagemId]
        );
        if (!membro) {
            return res.status(404).json({ error: 'Membro da equipe não encontrado.' });
        }
        await pool.query(
            `INSERT INTO montagem_reunioes_presencas (montagem_id, reuniao_id, jovem_id, membro_id, presente)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                jovem_id = VALUES(jovem_id),
                membro_id = VALUES(membro_id),
                presente = VALUES(presente)`,
            [montagemId, reuniaoId, membro.jovem_id || null, membroId, presente]
        );
        return res.json({ message: 'Presença atualizada.' });
    } catch (err) {
        console.error('Erro ao atualizar presença:', err);
        return res.status(500).json({ error: 'Erro ao atualizar presença.' });
    }
});

router.get('/:id/jovens-para-servir/search', async (req, res) => {
    const montagemId = Number(req.params.id);
    const q = String((req.query && req.query.q) || '').trim();
    const origem = String((req.query && req.query.origem) || '').trim().toUpperCase();
    const fonte = String((req.query && req.query.fonte) || '').trim().toUpperCase();
    const outroEjcId = Number((req.query && req.query.outro_ejc_id) || 0);
    if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
    const fonteFinal = fonte || (origem === 'OUTRO_EJC' ? 'OUTRO_EJC' : 'LISTA_MESTRE');
    if ((fonteFinal === 'LISTA_MESTRE' || fonteFinal === 'TIOS') && (!q || q.length < 2)) {
        return res.json([]);
    }
    if (fonteFinal === 'OUTRO_EJC' && !outroEjcId) {
        return res.status(400).json({ error: 'Selecione o EJC de origem para buscar jovens de outro EJC.' });
    }
    try {
        const tenantId = getTenantId(req);
        const hasMontagemEjcId = await hasColumn('jovens', 'montagem_ejc_id');
        if (fonteFinal === 'TIOS') {
            const [rows] = await pool.query(
                `SELECT id, nome_tio, nome_tia, telefone_tio, telefone_tia
                 FROM tios_casais
                 WHERE tenant_id = ?
                   AND (nome_tio LIKE ? OR nome_tia LIKE ?)
                 ORDER BY nome_tio ASC, nome_tia ASC
                 LIMIT 30`,
                [tenantId, `%${q}%`, `%${q}%`]
            );
            const out = rows.map(r => ({
                id: r.id,
                tipo: 'TIOS',
                nome_completo: [r.nome_tio, r.nome_tia].filter(Boolean).join(' e ') || r.nome_tio || r.nome_tia || 'Tios',
                telefone: montarTelefoneCasal(r.telefone_tio, r.telefone_tia) || ''
            }));
            return res.json(out);
        }

        const where = [
            'j.nome_completo LIKE ?',
            'j.tenant_id = ?'
        ];
        const params = [`%${q}%`, tenantId];

        if (fonteFinal === 'OUTRO_EJC') {
            where.push("COALESCE(j.origem_ejc_tipo, 'INCONFIDENTES') = 'OUTRO_EJC'");
            if (outroEjcId > 0) {
                where.push('j.outro_ejc_id = ?');
                params.push(outroEjcId);
            }
        } else {
            where.push("COALESCE(j.origem_ejc_tipo, 'INCONFIDENTES') <> 'OUTRO_EJC'");
            if (hasMontagemEjcId) {
                where.push('j.montagem_ejc_id IS NULL');
            }
        }

        const limit = (fonteFinal === 'OUTRO_EJC' && (!q || q.length < 2)) ? 200 : 30;
        const [rows] = await pool.query(`
            SELECT j.id, j.nome_completo, j.data_nascimento, j.telefone, j.numero_ejc_fez, j.outro_ejc_numero, j.outro_ejc_id,
                   j.estado_civil,
                   CASE
                       WHEN j.data_nascimento IS NULL THEN NULL
                       ELSE TIMESTAMPDIFF(YEAR, j.data_nascimento, CURDATE())
                   END AS idade
            FROM jovens j
            WHERE ${where.join(' AND ')}
            ORDER BY j.nome_completo ASC
            LIMIT ${limit}
        `, params);
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao buscar jovens para servir:', err);
        return res.status(500).json({ error: 'Erro ao buscar jovens para servir.' });
    }
});

// Adicionar um jovem a uma função (cargo) nessa montagem
router.post('/:id/membros', async (req, res) => {
    const { equipe_id, funcao_id, jovem_id } = req.body;
    const montagemId = req.params.id;
    const ehSubstituicao = req.body.eh_substituicao ? 1 : 0;

    try {
        const tenantId = getTenantId(req);
        await garantirEstruturaMontagemMembrosExtra();

        if (!ehSubstituicao) {
        const [emOutraEquipe] = await pool.query(
            `SELECT mm.id, mm.equipe_id, e.nome AS equipe_nome
             FROM montagem_membros mm
             JOIN equipes e ON e.id = mm.equipe_id
             WHERE mm.montagem_id = ?
               AND mm.jovem_id = ?
               AND mm.equipe_id <> ?
               AND mm.eh_substituicao = 0
               AND mm.tenant_id = ?
             LIMIT 1`,
            [montagemId, jovem_id, equipe_id, tenantId]
        );
        if (emOutraEquipe.length) {
            return res.status(409).json({
                error: `Esse jovem já está na equipe: ${emOutraEquipe[0].equipe_nome}.`,
                conflict: {
                    membro_id: emOutraEquipe[0].id,
                    equipe_id: emOutraEquipe[0].equipe_id,
                    equipe_nome: emOutraEquipe[0].equipe_nome
                }
            });
        }
        }

        const [duplicadoNaEquipe] = await pool.query(
            `SELECT mm.id, mm.funcao_id, ef.nome AS funcao_nome
             FROM montagem_membros mm
             LEFT JOIN equipes_funcoes ef ON ef.id = mm.funcao_id
             WHERE mm.montagem_id = ?
               AND mm.equipe_id = ?
               AND mm.jovem_id = ?
               AND mm.tenant_id = ?
             LIMIT 1`,
            [montagemId, equipe_id, jovem_id, tenantId]
        );
        if (duplicadoNaEquipe.length) {
            const nomeFuncao = String(duplicadoNaEquipe[0].funcao_nome || '').trim();
            return res.status(400).json({
                error: nomeFuncao
                    ? `Esse jovem já está nesta equipe (função: ${nomeFuncao}).`
                    : 'Esse jovem já está nesta equipe.'
            });
        }

        const [[equipeInfo]] = await pool.query(
            'SELECT id, nome, limite_homens, limite_mulheres FROM equipes WHERE id = ? AND tenant_id = ? LIMIT 1',
            [equipe_id, tenantId]
        );
        const [[jovemInfo]] = await pool.query(
            'SELECT id, sexo FROM jovens WHERE id = ? AND tenant_id = ? LIMIT 1',
            [jovem_id, tenantId]
        );
        if (!equipeInfo || !jovemInfo) {
            return res.status(404).json({ error: 'Equipe ou jovem não encontrado.' });
        }

        const erroRegras = await validarRegrasJovemNaMontagem({
            tenantId,
            montagemId,
            equipeId: equipe_id,
            funcaoId: funcao_id,
            jovemId: jovem_id
        });
        if (erroRegras) {
            return res.status(erroRegras.status || 409).json({ error: erroRegras.error || 'Alocação bloqueada pelas regras do EJC.' });
        }

        const [[ocupacaoEquipe]] = await pool.query(
            `SELECT
                SUM(CASE WHEN tc.id IS NOT NULL AND mm.jovem_id IS NULL THEN 2 ELSE 1 END) AS total,
                SUM(CASE
                        WHEN tc.id IS NOT NULL AND mm.jovem_id IS NULL THEN 1
                        WHEN LOWER(COALESCE(j.sexo, '')) = 'masculino' THEN 1
                        ELSE 0
                    END) AS homens,
                SUM(CASE
                        WHEN tc.id IS NOT NULL AND mm.jovem_id IS NULL THEN 1
                        WHEN LOWER(COALESCE(j.sexo, '')) = 'feminino' THEN 1
                        ELSE 0
                    END) AS mulheres
             FROM montagem_membros mm
             LEFT JOIN jovens j ON j.id = mm.jovem_id
             LEFT JOIN tios_casais tc
               ON tc.tenant_id = mm.tenant_id
              AND TRIM(CONCAT(COALESCE(tc.nome_tio, ''), ' e ', COALESCE(tc.nome_tia, ''))) = TRIM(COALESCE(mm.nome_externo, ''))
             WHERE mm.montagem_id = ?
               AND mm.equipe_id = ?
               AND mm.tenant_id = ?`,
            [montagemId, equipe_id, tenantId]
        );
        const grupoSexo = contarSexosDoGrupo([{ tipo: 'jovem', item: { sexo: jovemInfo.sexo } }]);
        if (!equipeComportaGrupo(equipeInfo, {
            total: Number(ocupacaoEquipe.total || 0),
            homens: Number(ocupacaoEquipe.homens || 0),
            mulheres: Number(ocupacaoEquipe.mulheres || 0)
        }, grupoSexo)) {
            const sexo = normalizarSexo(jovemInfo.sexo);
            return res.status(409).json({
                error: sexo === 'masculino'
                    ? `A equipe ${equipeInfo.nome} atingiu o limite de homens.`
                    : sexo === 'feminino'
                        ? `A equipe ${equipeInfo.nome} atingiu o limite de mulheres.`
                        : `A equipe ${equipeInfo.nome} atingiu o limite configurado para este sexo.`
            });
        }

        const [jaExiste] = await pool.query(
            'SELECT id FROM montagem_membros WHERE montagem_id = ? AND equipe_id = ? AND funcao_id = ? AND jovem_id = ? AND tenant_id = ? LIMIT 1',
            [montagemId, equipe_id, funcao_id, jovem_id, tenantId]
        );
        if (jaExiste.length > 0) {
            await pool.query(
                'UPDATE montagem_membros SET eh_substituicao = ? WHERE id = ? AND tenant_id = ?',
                [ehSubstituicao, jaExiste[0].id, tenantId]
            );
            if (ehSubstituicao) {
                await removerHistoricoDaAlocacao({
                    montagemId,
                    equipeId: equipe_id,
                    funcaoId: funcao_id,
                    jovemId: jovem_id,
                    tenantId
                });
                return res.status(200).json({ id: jaExiste[0].id, message: "Jovem atualizado como reserva; histórico removido." });
            }
            await sincronizarHistoricoDaAlocacao({
                montagemId,
                equipeId: equipe_id,
                funcaoId: funcao_id,
                jovemId: jovem_id,
                tenantId
            });
            return res.status(200).json({ id: jaExiste[0].id, message: "Jovem já estava alocado; histórico sincronizado." });
        }

        // 1. Inserir na tabela de montagem (o que já fazíamos)
        const [result] = await pool.query(
            'INSERT INTO montagem_membros (tenant_id, montagem_id, equipe_id, funcao_id, jovem_id, eh_substituicao) VALUES (?, ?, ?, ?, ?, ?)',
            [tenantId, montagemId, equipe_id, funcao_id, jovem_id, ehSubstituicao]
        );

        if (!ehSubstituicao) {
            await sincronizarHistoricoDaAlocacao({
                montagemId,
                equipeId: equipe_id,
                funcaoId: funcao_id,
                jovemId: jovem_id,
                tenantId
            });
        }

        res.json({ id: result.insertId, message: "Jovem alocado e histórico atualizado!" });
    } catch (err) {
        console.error("Erro ao alocar membro e salvar histórico:", err);
        res.status(500).json({ error: "Erro ao processar alocação" });
    }
});

router.post('/:id/membros-externos', async (req, res) => {
    const montagemId = req.params.id;
    const equipeId = Number(req.body.equipe_id);
    const funcaoId = Number(req.body.funcao_id);
    const nome = String(req.body.nome_completo || '').trim();
    const telefone = String(req.body.telefone || '').trim() || null;
    const ehSubstituicao = req.body.eh_substituicao ? 1 : 0;
    if (!equipeId || !funcaoId || !nome) return res.status(400).json({ error: 'Dados obrigatórios: equipe, função e nome.' });

    try {
        const tenantId = getTenantId(req);
        await garantirEstruturaMontagemMembrosExtra();
        const erroRegras = await validarRegrasMembroExternoNaMontagem({
            tenantId,
            montagemId,
            equipeId,
            funcaoId,
            origemTipo: req.body && req.body.origem_tipo
        });
        if (erroRegras) {
            return res.status(erroRegras.status || 409).json({ error: erroRegras.error || 'Alocação bloqueada pelas regras do EJC.' });
        }
        const [result] = await pool.query(
            `INSERT INTO montagem_membros
                (tenant_id, montagem_id, equipe_id, funcao_id, jovem_id, eh_substituicao, nome_externo, telefone_externo)
             VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
            [tenantId, montagemId, equipeId, funcaoId, ehSubstituicao, nome, telefone]
        );
        return res.json({ id: result.insertId, message: 'Membro externo adicionado.' });
    } catch (err) {
        console.error('Erro ao adicionar membro externo:', err);
        return res.status(500).json({ error: 'Erro ao adicionar membro externo.' });
    }
});

router.post('/:id/equipes/:equipeId/importar-externos', async (req, res) => {
    const montagemId = Number(req.params.id);
    const equipeId = Number(req.params.equipeId);
    const lista = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!montagemId || !equipeId || !lista.length) return res.status(400).json({ error: 'Dados inválidos para importação.' });

    try {
        const tenantId = getTenantId(req);
        await garantirEstruturaMontagemMembrosExtra();
        let inseridos = 0;
        for (const item of lista) {
            const nome = String(item.nome_completo || '').trim();
            const telefone = String(item.telefone || '').trim() || null;
            const funcaoId = Number(item.funcao_id);
            const ehSubstituicao = item.eh_substituicao ? 1 : 0;
            if (!nome || !funcaoId) continue;
            await pool.query(
                `INSERT INTO montagem_membros
                    (tenant_id, montagem_id, equipe_id, funcao_id, jovem_id, eh_substituicao, nome_externo, telefone_externo)
                 VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
                [tenantId, montagemId, equipeId, funcaoId, ehSubstituicao, nome, telefone]
            );
            inseridos++;
        }
        return res.json({ message: 'Importação concluída.', inseridos });
    } catch (err) {
        console.error('Erro ao importar membros externos:', err);
        return res.status(500).json({ error: 'Erro ao importar membros externos.' });
    }
});

router.get('/:id/equipes/:equipeId/detalhes', async (req, res) => {
    const montagemId = Number(req.params.id);
    const equipeId = Number(req.params.equipeId);
    if (!montagemId || !equipeId) return res.status(400).json({ error: 'Parâmetros inválidos.' });

    try {
        const tenantId = getTenantId(req);
        await garantirEstruturaMontagemMembrosExtra();
        const [rows] = await pool.query(`
            SELECT mm.id AS membro_id, mm.equipe_id, mm.funcao_id, mm.jovem_id,
                   mm.status_ligacao, mm.motivo_recusa, mm.eh_substituicao,
                   mm.nome_externo, mm.telefone_externo,
                   ef.nome AS funcao_nome, COALESCE(ef.papel_base, 'Membro') AS papel_base,
                   j.nome_completo AS jovem_nome, j.telefone AS jovem_telefone,
                   tc.telefone_tio, tc.telefone_tia
            FROM montagem_membros mm
            JOIN equipes_funcoes ef ON ef.id = mm.funcao_id
            LEFT JOIN jovens j ON j.id = mm.jovem_id
            LEFT JOIN tios_casais tc
              ON tc.tenant_id = mm.tenant_id
             AND TRIM(CONCAT(COALESCE(tc.nome_tio, ''), ' e ', COALESCE(tc.nome_tia, ''))) = TRIM(COALESCE(mm.nome_externo, ''))
            WHERE mm.montagem_id = ? AND mm.equipe_id = ? AND mm.tenant_id = ?
              AND (mm.status_ligacao IS NULL OR mm.status_ligacao <> 'RECUSOU')
            ORDER BY COALESCE(j.nome_completo, mm.nome_externo) ASC
        `, [montagemId, equipeId, tenantId]);

        const titular = rows.filter(r => !r.eh_substituicao);
        const substituicoes = rows.filter(r => r.eh_substituicao === 1);
        return res.json({ titular, substituicoes });
    } catch (err) {
        console.error('Erro ao buscar detalhes da equipe na montagem:', err);
        return res.status(500).json({ error: 'Erro ao buscar detalhes da equipe.' });
    }
});

router.patch('/membro/:membroId/ligacao', async (req, res) => {
    const membroId = Number(req.params.membroId);
    const statusRaw = String(req.body.status_ligacao || '').trim().toUpperCase();
    const status = ['ACEITOU', 'RECUSOU', 'LIGAR_MAIS_TARDE', 'TELEFONE_INCORRETO'].includes(statusRaw) ? statusRaw : null;
    const motivoRecusa = String(req.body.motivo_recusa || '').trim() || null;
    if (!membroId || !status) return res.status(400).json({ error: 'Status inválido.' });
    if (status === 'RECUSOU' && !motivoRecusa) return res.status(400).json({ error: 'Informe o motivo da recusa.' });

    try {
        const tenantId = getTenantId(req);
        await garantirEstruturaMontagemMembrosExtra();
        const [[membro]] = await pool.query(`
            SELECT mm.id, mm.jovem_id, mm.montagem_id, mm.equipe_id, mm.funcao_id,
                   m.numero_ejc, e.nome AS equipe_nome
            FROM montagem_membros mm
            JOIN montagens m ON m.id = mm.montagem_id
            LEFT JOIN equipes e ON e.id = mm.equipe_id
            WHERE mm.id = ? AND mm.tenant_id = ?
            LIMIT 1
        `, [membroId, tenantId]);
        if (!membro) return res.status(404).json({ error: 'Membro não encontrado.' });

        await pool.query(
            'UPDATE montagem_membros SET status_ligacao = ?, motivo_recusa = ? WHERE id = ? AND tenant_id = ?',
            [status, status === 'RECUSOU' ? motivoRecusa : motivoRecusa, membroId, tenantId]
        );

        if (status === 'RECUSOU' && membro.jovem_id) {
            const texto = `Jovem recusou servir no ${membro.numero_ejc}º encontro de montagem. Motivo: ${motivoRecusa}`;
            await pool.query(
                'INSERT INTO jovens_observacoes (tenant_id, jovem_id, texto) VALUES (?, ?, ?)',
                [tenantId, membro.jovem_id, texto]
            );
            if (membro.montagem_id && membro.equipe_id && membro.funcao_id) {
                await removerHistoricoDaAlocacao({
                    montagemId: membro.montagem_id,
                    equipeId: membro.equipe_id,
                    funcaoId: membro.funcao_id,
                    jovemId: membro.jovem_id,
                    tenantId
                });
            }
            if (membro.jovem_id && membro.numero_ejc && membro.equipe_nome) {
                const edicaoMontagem = montarEtiquetaEdicao(membro.numero_ejc);
                const likeMontagem = `${membro.numero_ejc}%EJC (Montagem)%`;
                await pool.query(
                    `DELETE FROM historico_equipes
                     WHERE jovem_id = ?
                       AND tenant_id = ?
                       AND equipe = ?
                       AND (edicao_ejc <=> ? OR edicao_ejc LIKE ?)`,
                    [membro.jovem_id, tenantId, membro.equipe_nome, edicaoMontagem, likeMontagem]
                );
            }
        } else if (status === 'ACEITOU' && membro.jovem_id) {
            if (membro.montagem_id && membro.equipe_id && membro.funcao_id && membro.eh_substituicao === 0) {
                await sincronizarHistoricoDaAlocacao({
                    montagemId: membro.montagem_id,
                    equipeId: membro.equipe_id,
                    funcaoId: membro.funcao_id,
                    jovemId: membro.jovem_id,
                    tenantId
                });
            }
        }

        return res.json({ message: 'Status de ligação atualizado.' });
    } catch (err) {
        console.error('Erro ao atualizar status de ligação:', err);
        return res.status(500).json({ error: 'Erro ao atualizar status de ligação.' });
    }
});

router.get('/:id/ligacoes', async (req, res) => {
    const montagemId = Number(req.params.id);
    if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
    try {
        const tenantId = getTenantId(req);
        await garantirEstruturaMontagemMembrosExtra();
        const [rows] = await pool.query(`
            SELECT mm.id AS membro_id, mm.equipe_id, e.nome AS equipe_nome,
                   mm.funcao_id, ef.nome AS funcao_nome,
                   mm.jovem_id, j.nome_completo AS jovem_nome, j.telefone AS jovem_telefone,
                   j.data_nascimento AS jovem_data_nascimento,
                   CASE
                       WHEN j.data_nascimento IS NULL THEN NULL
                       ELSE TIMESTAMPDIFF(YEAR, j.data_nascimento, CURDATE())
                   END AS jovem_idade,
                   COALESCE(j.origem_ejc_tipo, 'INCONFIDENTES') AS origem_ejc_tipo,
                   j.outro_ejc_numero, j.outro_ejc_id,
                   oe.nome AS outro_ejc_nome, oe.paroquia AS outro_ejc_paroquia,
                   mm.status_ligacao, mm.motivo_recusa, mm.eh_substituicao,
                   mm.nome_externo, mm.telefone_externo,
                   tc.telefone_tio, tc.telefone_tia
            FROM montagem_membros mm
            JOIN equipes e ON e.id = mm.equipe_id
            JOIN equipes_funcoes ef ON ef.id = mm.funcao_id
            LEFT JOIN jovens j ON j.id = mm.jovem_id
            LEFT JOIN outros_ejcs oe ON oe.id = j.outro_ejc_id
            LEFT JOIN tios_casais tc
              ON tc.tenant_id = mm.tenant_id
             AND TRIM(CONCAT(COALESCE(tc.nome_tio, ''), ' e ', COALESCE(tc.nome_tia, ''))) = TRIM(COALESCE(mm.nome_externo, ''))
            WHERE mm.montagem_id = ?
              AND mm.tenant_id = ?
              AND mm.eh_substituicao = 0
            ORDER BY e.nome ASC, COALESCE(j.nome_completo, mm.nome_externo) ASC
        `, [montagemId, tenantId]);

        const recusas = [];
        const equipesMap = new Map();
        for (const row of rows) {
            const item = {
                membro_id: row.membro_id,
                equipe_id: row.equipe_id,
                equipe_nome: row.equipe_nome,
                funcao_id: row.funcao_id,
                funcao_nome: row.funcao_nome,
                jovem_id: row.jovem_id,
                jovem_nome: row.jovem_nome,
                jovem_telefone: row.jovem_telefone,
                jovem_data_nascimento: row.jovem_data_nascimento,
                jovem_idade: row.jovem_idade,
                origem_ejc_tipo: row.origem_ejc_tipo,
                outro_ejc_numero: row.outro_ejc_numero,
                outro_ejc_id: row.outro_ejc_id,
                outro_ejc_nome: row.outro_ejc_nome,
                outro_ejc_paroquia: row.outro_ejc_paroquia,
                nome_externo: row.nome_externo,
                telefone_externo: row.telefone_externo,
                telefone_tio: row.telefone_tio,
                telefone_tia: row.telefone_tia,
                status_ligacao: row.status_ligacao,
                motivo_recusa: row.motivo_recusa,
                eh_substituicao: row.eh_substituicao ? 1 : 0
            };
            if (String(row.status_ligacao || '').toUpperCase() === 'RECUSOU') {
                recusas.push(item);
                continue;
            }
            if (!equipesMap.has(row.equipe_id)) {
                equipesMap.set(row.equipe_id, { id: row.equipe_id, nome: row.equipe_nome, membros: [] });
            }
            equipesMap.get(row.equipe_id).membros.push(item);
        }

        return res.json({ equipes: Array.from(equipesMap.values()), recusas });
    } catch (err) {
        console.error('Erro ao carregar ligações:', err);
        return res.status(500).json({ error: 'Erro ao carregar ligações.' });
    }
});

router.get('/:id/ligacoes/pendentes', async (req, res) => {
    const montagemId = Number(req.params.id);
    if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
    try {
        const tenantId = getTenantId(req);
        await garantirEstruturaMontagemMembrosExtra();
        const [rows] = await pool.query(
            `SELECT e.nome AS equipe_nome, COUNT(*) AS total
             FROM montagem_membros mm
             JOIN equipes e ON e.id = mm.equipe_id
             WHERE mm.montagem_id = ?
               AND mm.tenant_id = ?
               AND mm.eh_substituicao = 0
               AND (mm.status_ligacao IS NULL OR (mm.status_ligacao <> 'ACEITOU' AND mm.status_ligacao <> 'RECUSOU'))
             GROUP BY e.id, e.nome
             ORDER BY e.nome ASC`,
            [montagemId, tenantId]
        );
        return res.json({ pendentes: rows || [] });
    } catch (err) {
        console.error('Erro ao verificar pendências de ligações:', err);
        return res.status(500).json({ error: 'Erro ao verificar pendências.' });
    }
});

async function finalizarEncontroHandler(req, res) {
    const montagemId = Number(req.params.id);
    if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
    try {
        await garantirEstruturaMontagemDatas();
        await garantirEstruturaEjcDatasMontagem();
    } catch (err) {
        console.error('Erro ao preparar estrutura do EJC:', err);
        return res.status(500).json({ error: 'Erro ao preparar estrutura do EJC.' });
    }
    const connection = await pool.getConnection();
    try {
        const tenantId = getTenantId(req);
        await connection.beginTransaction();

        const [[montagem]] = await connection.query(
            `SELECT id, numero_ejc, data_encontro, data_inicio, data_fim, data_tarde_revelacao, data_inicio_reunioes, data_fim_reunioes, dia_semana_reunioes
             FROM montagens
             WHERE id = ? AND tenant_id = ?
             LIMIT 1`,
            [montagemId, tenantId]
        );
        if (!montagem) {
            await connection.rollback();
            return res.status(404).json({ error: 'Montagem não encontrada.' });
        }

        const [pendentes] = await connection.query(
            `SELECT e.nome AS equipe_nome, COUNT(*) AS total
             FROM montagem_membros mm
             JOIN equipes e ON e.id = mm.equipe_id
             WHERE mm.montagem_id = ?
               AND mm.tenant_id = ?
               AND mm.eh_substituicao = 0
               AND (mm.status_ligacao IS NULL OR (mm.status_ligacao <> 'ACEITOU' AND mm.status_ligacao <> 'RECUSOU'))
             GROUP BY e.id, e.nome`,
            [montagemId, tenantId]
        );
        if (pendentes && pendentes.length) {
            await connection.rollback();
            return res.status(400).json({ error: 'Pendências de ligação.', pendentes });
        }

        let ejcId = null;
        const dataInicioEjc = montagem.data_inicio || montagem.data_encontro || null;
        const dataFimEjc = montagem.data_fim || montagem.data_tarde_revelacao || montagem.data_encontro || null;
        const anoBase = (montagem.data_inicio || montagem.data_encontro)
            ? Number(String(montagem.data_inicio || montagem.data_encontro).slice(0, 4))
            : new Date().getFullYear();
        const [[ejc]] = await connection.query(
            'SELECT id, ano FROM ejc WHERE tenant_id = ? AND numero = ? LIMIT 1',
            [tenantId, montagem.numero_ejc]
        );
        if (ejc && ejc.id) {
            ejcId = ejc.id;
            const anoFinal = Number.isFinite(anoBase) ? anoBase : (ejc.ano || new Date().getFullYear());
            await connection.query(
                `UPDATE ejc
                 SET ano = ?,
                     data_inicio = ?,
                     data_fim = ?,
                     data_encontro = ?,
                     data_tarde_revelacao = ?,
                     data_inicio_reunioes = ?,
                     data_fim_reunioes = ?,
                     dia_semana_reunioes = ?
                 WHERE id = ? AND tenant_id = ?`,
                [
                    anoFinal,
                    dataInicioEjc,
                    dataFimEjc,
                    montagem.data_encontro || null,
                    montagem.data_tarde_revelacao || null,
                    montagem.data_inicio_reunioes || null,
                    montagem.data_fim_reunioes || null,
                    normalizarDiaSemana(montagem.dia_semana_reunioes),
                    ejcId,
                    tenantId
                ]
            );
        } else {
            const [[tenantRow]] = await connection.query(
                'SELECT nome_ejc, paroquia FROM tenants_ejc WHERE id = ? LIMIT 1',
                [tenantId]
            );
            const paroquia = tenantRow && tenantRow.paroquia ? tenantRow.paroquia : null;
            const ano = Number.isFinite(anoBase) ? anoBase : new Date().getFullYear();
            const [ejcRes] = await connection.query(
                `INSERT INTO ejc (tenant_id, numero, paroquia, ano, data_inicio, data_fim, data_encontro, data_tarde_revelacao, data_inicio_reunioes, data_fim_reunioes, dia_semana_reunioes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    tenantId,
                    montagem.numero_ejc,
                    paroquia,
                    ano,
                    dataInicioEjc,
                    dataFimEjc,
                    montagem.data_encontro || null,
                    montagem.data_tarde_revelacao || null,
                    montagem.data_inicio_reunioes || null,
                    montagem.data_fim_reunioes || null,
                    normalizarDiaSemana(montagem.dia_semana_reunioes)
                ]
            );
            ejcId = ejcRes.insertId;
            await connection.query(
                `INSERT IGNORE INTO equipes_ejc (tenant_id, ejc_id, equipe_id)
                 SELECT ?, ?, id FROM equipes WHERE tenant_id = ?`,
                [tenantId, ejcId, tenantId]
            );
        }

        await connection.query(
            `INSERT IGNORE INTO equipes_ejc (tenant_id, ejc_id, equipe_id)
             SELECT ?, ?, id FROM equipes WHERE tenant_id = ?`,
            [tenantId, ejcId, tenantId]
        );

        const comSubfuncao = await hasSubfuncaoColumn();
        const comPapelBase = await hasPapelBaseColumn();
        await ensureHistoricoEquipesSnapshots();
        await ensureHistoricoEquipesYoungFkPreserved();
        await ensureEjcEncontristasHistoricoTable();
        const papelBaseSelect = comPapelBase
            ? 'COALESCE(ef.papel_base, "Membro")'
            : '"Membro"';
        const [membros] = await connection.query(
            `SELECT mm.jovem_id, mm.eh_substituicao, mm.status_ligacao,
                    e.nome AS equipe_nome, ef.nome AS funcao_nome, ${papelBaseSelect} AS papel_base,
                    j.nome_completo, j.telefone,
                    COALESCE(j.origem_ejc_tipo, 'INCONFIDENTES') AS origem_ejc_tipo,
                    j.outro_ejc_numero, j.outro_ejc_id,
                    oe.nome AS outro_ejc_nome, oe.paroquia AS outro_ejc_paroquia
             FROM montagem_membros mm
             JOIN equipes e ON e.id = mm.equipe_id
             JOIN equipes_funcoes ef ON ef.id = mm.funcao_id
             JOIN jovens j ON j.id = mm.jovem_id AND j.tenant_id = mm.tenant_id
             LEFT JOIN outros_ejcs oe ON oe.id = j.outro_ejc_id AND oe.tenant_id = j.tenant_id
             WHERE mm.montagem_id = ?
               AND mm.tenant_id = ?`,
            [montagemId, tenantId]
        );

        const edicaoFinal = `${montagem.numero_ejc}º EJC`;
        const edicaoMontagem = montarEtiquetaEdicao(montagem.numero_ejc);
        const likeMontagem = `${montagem.numero_ejc}%EJC (Montagem)%`;
        if (Array.isArray(membros) && membros.length) {
            for (const membro of membros) {
                if (!membro || !membro.jovem_id) continue;
                if (membro.eh_substituicao) continue;
                if (String(membro.status_ligacao || '').toUpperCase() === 'RECUSOU') continue;
                const papelMapeado = membro.papel_base || mapearPapelPorNomeFuncao(membro.funcao_nome);
                const subfuncao = membro.funcao_nome || null;
                if (comSubfuncao) {
                    const [jaExiste] = await connection.query(
                        `SELECT id
                         FROM historico_equipes
                         WHERE tenant_id = ?
                           AND jovem_id = ?
                           AND equipe = ?
                           AND papel = ?
                           AND (ejc_id = ? OR edicao_ejc = ? OR edicao_ejc LIKE ?)
                           AND (subfuncao <=> ?)
                         LIMIT 1`,
                        [tenantId, membro.jovem_id, membro.equipe_nome, papelMapeado, ejcId, edicaoMontagem, likeMontagem, subfuncao]
                    );
                    if (!jaExiste.length) {
                        await connection.query(
                            `INSERT INTO historico_equipes (
                                tenant_id, jovem_id, edicao_ejc, equipe, papel, subfuncao, ejc_id,
                                nome_completo_snapshot, telefone_snapshot, origem_ejc_tipo_snapshot,
                                outro_ejc_numero_snapshot, outro_ejc_id_snapshot, outro_ejc_nome_snapshot, outro_ejc_paroquia_snapshot
                             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [
                                tenantId,
                                membro.jovem_id,
                                edicaoFinal,
                                membro.equipe_nome,
                                papelMapeado,
                                subfuncao,
                                ejcId,
                                membro.nome_completo || null,
                                membro.telefone || null,
                                membro.origem_ejc_tipo || 'INCONFIDENTES',
                                membro.outro_ejc_numero || null,
                                membro.outro_ejc_id || null,
                                membro.outro_ejc_nome || null,
                                membro.outro_ejc_paroquia || null
                            ]
                        );
                    }
                } else {
                    const [jaExiste] = await connection.query(
                        `SELECT id
                         FROM historico_equipes
                         WHERE tenant_id = ?
                           AND jovem_id = ?
                           AND equipe = ?
                           AND papel = ?
                           AND (ejc_id = ? OR edicao_ejc = ? OR edicao_ejc LIKE ?)
                         LIMIT 1`,
                        [tenantId, membro.jovem_id, membro.equipe_nome, papelMapeado, ejcId, edicaoMontagem, likeMontagem]
                    );
                    if (!jaExiste.length) {
                        await connection.query(
                            `INSERT INTO historico_equipes (
                                tenant_id, jovem_id, edicao_ejc, equipe, papel, ejc_id,
                                nome_completo_snapshot, telefone_snapshot, origem_ejc_tipo_snapshot,
                                outro_ejc_numero_snapshot, outro_ejc_id_snapshot, outro_ejc_nome_snapshot, outro_ejc_paroquia_snapshot
                             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [
                                tenantId,
                                membro.jovem_id,
                                edicaoFinal,
                                membro.equipe_nome,
                                papelMapeado,
                                ejcId,
                                membro.nome_completo || null,
                                membro.telefone || null,
                                membro.origem_ejc_tipo || 'INCONFIDENTES',
                                membro.outro_ejc_numero || null,
                                membro.outro_ejc_id || null,
                                membro.outro_ejc_nome || null,
                                membro.outro_ejc_paroquia || null
                            ]
                        );
                    }
                }
            }
        }

        await connection.query(
            `UPDATE historico_equipes
             SET ejc_id = ?, edicao_ejc = ?
             WHERE tenant_id = ?
               AND (edicao_ejc = ? OR edicao_ejc LIKE ?)`,
            [ejcId, edicaoFinal, tenantId, montarEtiquetaEdicao(montagem.numero_ejc), likeMontagem]
        );

        // Finaliza encontristas da montagem no cadastro de jovens
        const encontristasPayload = Array.isArray(req.body && req.body.encontristas) ? req.body.encontristas : [];
        await garantirMontagemEncontristasDados();
        const [encontristasDbDados] = await connection.query(
            `SELECT resposta_id, nome_referencia, telefone_referencia, circulo, cep, endereco, numero, bairro, cidade, complemento
             FROM montagem_encontristas_dados
             WHERE tenant_id = ? AND montagem_id = ?`,
            [tenantId, montagemId]
        );
        const dbByResposta = new Map((encontristasDbDados || []).map((r) => [Number(r.resposta_id), r]));
        const encontristasEfetivos = (encontristasPayload || []).map((item) => {
            const rid = Number(item && item.id);
            const db = dbByResposta.get(rid);
            return {
                id: rid,
                nome_referencia: (db && db.nome_referencia) || (item && item.nome_referencia) || '',
                telefone_referencia: (db && db.telefone_referencia) || (item && item.telefone_referencia) || '',
                circulo: (db && db.circulo) || (item && item.circulo) || null,
                cep: (db && db.cep) || (item && item.cep) || null,
                endereco: (db && db.endereco) || (item && item.endereco) || null,
                numero: (db && db.numero) || (item && item.numero) || null,
                bairro: (db && db.bairro) || (item && item.bairro) || null,
                cidade: (db && db.cidade) || (item && item.cidade) || null,
                complemento: (db && db.complemento) || (item && item.complemento) || null
            };
        });

        await connection.query(
            'DELETE FROM ejc_encontristas_historico WHERE tenant_id = ? AND ejc_id = ?',
            [tenantId, ejcId]
        );
        for (const item of encontristasEfetivos) {
            const nome = String((item && item.nome_referencia) || '').trim();
            if (!nome) continue;
            const telefone = String((item && item.telefone_referencia) || '').trim() || null;
            const circulo = String((item && item.circulo) || '').trim() || null;
            const respostaId = Number(item && item.id);
            await connection.query(
                `INSERT INTO ejc_encontristas_historico
                    (tenant_id, ejc_id, jovem_id, resposta_id, nome_completo_snapshot, telefone_snapshot, circulo_snapshot, foi_moita, moita_funcao_snapshot)
                 VALUES (?, ?, NULL, ?, ?, ?, ?, 0, NULL)`,
                [tenantId, ejcId, Number.isInteger(respostaId) ? respostaId : null, nome, telefone, circulo]
            );
        }

        if (encontristasEfetivos.length) {
            const comOrigemEjcTipo = await hasColumn('jovens', 'origem_ejc_tipo');
            const comEstadoCivil = await hasColumn('jovens', 'estado_civil');
            const comMontagemEjcId = await hasColumn('jovens', 'montagem_ejc_id');
            const comEnderecoRua = await hasColumn('jovens', 'endereco_rua');
            const comEnderecoNumero = await hasColumn('jovens', 'endereco_numero');
            const comEnderecoBairro = await hasColumn('jovens', 'endereco_bairro');
            const comEnderecoCidade = await hasColumn('jovens', 'endereco_cidade');
            const comEnderecoCep = await hasColumn('jovens', 'endereco_cep');
            for (const item of encontristasEfetivos) {
                const nome = String((item && item.nome_referencia) || '').trim();
                const telefone = String((item && item.telefone_referencia) || '').trim();
                const circulo = String((item && item.circulo) || '').trim() || null;
                const respostaId = Number(item && item.id);
                const enderecoRua = String((item && item.endereco) || '').trim() || null;
                const enderecoNumero = String((item && item.numero) || '').trim() || null;
                const enderecoBairro = String((item && item.bairro) || '').trim() || null;
                const enderecoCidade = String((item && item.cidade) || '').trim() || null;
                const enderecoCep = String((item && item.cep) || '').trim() || null;
                const jovemListaMestreId = Number(item && item.id);
                if (!nome || !telefone) continue;

                if (jovemListaMestreId < 0) {
                    const jovemId = Math.abs(jovemListaMestreId);
                    const sets = ['nome_completo = ?', 'numero_ejc_fez = ?', 'circulo = ?'];
                    const params = [nome, ejcId, circulo];
                    if (comMontagemEjcId) {
                        sets.push('montagem_ejc_id = NULL');
                    }
                    if (comEnderecoRua) { sets.push('endereco_rua = ?'); params.push(enderecoRua); }
                    if (comEnderecoNumero) { sets.push('endereco_numero = ?'); params.push(enderecoNumero); }
                    if (comEnderecoBairro) { sets.push('endereco_bairro = ?'); params.push(enderecoBairro); }
                    if (comEnderecoCidade) { sets.push('endereco_cidade = ?'); params.push(enderecoCidade); }
                    if (comEnderecoCep) { sets.push('endereco_cep = ?'); params.push(enderecoCep); }
                    params.push(jovemId, tenantId);
                    await connection.query(
                        `UPDATE jovens
                         SET ${sets.join(', ')}
                         WHERE id = ?
                           AND tenant_id = ?`,
                        params
                    );
                    if (Number.isInteger(respostaId)) {
                        await connection.query(
                            `UPDATE ejc_encontristas_historico
                             SET jovem_id = ?
                             WHERE tenant_id = ?
                               AND ejc_id = ?
                               AND resposta_id = ?`,
                            [jovemId, tenantId, ejcId, respostaId]
                        );
                    }
                    continue;
                }

                let jovem = null;
                const [byPhone] = await connection.query(
                    `SELECT id
                     FROM jovens
                     WHERE tenant_id = ?
                       AND telefone = ?
                     LIMIT 1`,
                    [tenantId, telefone]
                );
                if (byPhone && byPhone.length) {
                    jovem = byPhone[0];
                } else {
                    const telDigits = normalizarTelefoneDigits(telefone);
                    if (telDigits) {
                        const [byDigits] = await connection.query(
                            `SELECT id
                             FROM jovens
                             WHERE tenant_id = ?
                               AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(telefone, ''), '(', ''), ')', ''), '-', ''), ' ', ''), '+', '') = ?
                             LIMIT 1`,
                            [tenantId, telDigits]
                        );
                        if (byDigits && byDigits.length) jovem = byDigits[0];
                    }
                }

                if (jovem && jovem.id) {
                    const sets = ['nome_completo = ?', 'numero_ejc_fez = ?', 'circulo = ?'];
                    const params = [nome, ejcId, circulo];
                    if (comMontagemEjcId) {
                        sets.push('montagem_ejc_id = NULL');
                    }
                    if (comEnderecoRua) { sets.push('endereco_rua = ?'); params.push(enderecoRua); }
                    if (comEnderecoNumero) { sets.push('endereco_numero = ?'); params.push(enderecoNumero); }
                    if (comEnderecoBairro) { sets.push('endereco_bairro = ?'); params.push(enderecoBairro); }
                    if (comEnderecoCidade) { sets.push('endereco_cidade = ?'); params.push(enderecoCidade); }
                    if (comEnderecoCep) { sets.push('endereco_cep = ?'); params.push(enderecoCep); }
                    params.push(jovem.id, tenantId);
                    await connection.query(
                        `UPDATE jovens
                         SET ${sets.join(', ')}
                         WHERE id = ?
                           AND tenant_id = ?`,
                        params
                    );
                    if (Number.isInteger(respostaId)) {
                        await connection.query(
                            `UPDATE ejc_encontristas_historico
                             SET jovem_id = ?
                             WHERE tenant_id = ?
                               AND ejc_id = ?
                               AND resposta_id = ?`,
                            [jovem.id, tenantId, ejcId, respostaId]
                        );
                    }
                    continue;
                }

                const cols = ['tenant_id', 'nome_completo', 'telefone', 'numero_ejc_fez', 'circulo'];
                const vals = [tenantId, nome, telefone, ejcId, circulo];
                if (comOrigemEjcTipo) {
                    cols.push('origem_ejc_tipo');
                    vals.push('INCONFIDENTES');
                }
                if (comEstadoCivil) {
                    cols.push('estado_civil');
                    vals.push('Solteiro');
                }
                if (comEnderecoRua) { cols.push('endereco_rua'); vals.push(enderecoRua); }
                if (comEnderecoNumero) { cols.push('endereco_numero'); vals.push(enderecoNumero); }
                if (comEnderecoBairro) { cols.push('endereco_bairro'); vals.push(enderecoBairro); }
                if (comEnderecoCidade) { cols.push('endereco_cidade'); vals.push(enderecoCidade); }
                if (comEnderecoCep) { cols.push('endereco_cep'); vals.push(enderecoCep); }
                const marks = cols.map(() => '?').join(', ');
                const [insertResult] = await connection.query(
                    `INSERT INTO jovens (${cols.join(', ')}) VALUES (${marks})`,
                    vals
                );
                if (Number.isInteger(respostaId)) {
                    await connection.query(
                        `UPDATE ejc_encontristas_historico
                         SET jovem_id = ?
                         WHERE tenant_id = ?
                           AND ejc_id = ?
                           AND resposta_id = ?`,
                        [insertResult.insertId, tenantId, ejcId, respostaId]
                    );
                }
            }
        }

        await connection.query('DELETE FROM montagem_reunioes_presencas WHERE montagem_id = ?', [montagemId]);
        await connection.query('DELETE FROM montagem_reunioes WHERE montagem_id = ?', [montagemId]);
        await connection.query('DELETE FROM montagem_jovens_servir WHERE montagem_id = ?', [montagemId]).catch(() => {});
        await connection.query('DELETE FROM montagem_tios_servir WHERE montagem_id = ?', [montagemId]).catch(() => {});
        await connection.query('DELETE FROM montagem_membros WHERE montagem_id = ? AND tenant_id = ?', [montagemId, tenantId]);
        await connection.query('DELETE FROM montagens WHERE id = ? AND tenant_id = ?', [montagemId, tenantId]);

        await connection.commit();
        return res.json({ message: 'Encontro finalizado com sucesso.' });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao finalizar encontro:', err);
        return res.status(500).json({ error: 'Erro ao finalizar encontro.' });
    } finally {
        connection.release();
    }
}

router.post('/:id/finalizar', finalizarEncontroHandler);

router.patch('/membro/:membroId/mover-titular', async (req, res) => {
    const membroId = Number(req.params.membroId);
    const forcar = req.body && req.body.forcar ? 1 : 0;
    if (!membroId) return res.status(400).json({ error: 'ID inválido.' });
    try {
        const tenantId = getTenantId(req);
        await garantirEstruturaMontagemMembrosExtra();
        const [[membro]] = await pool.query(
            `SELECT id, montagem_id, equipe_id, funcao_id, jovem_id
             FROM montagem_membros
             WHERE id = ? AND tenant_id = ?
             LIMIT 1`,
            [membroId, tenantId]
        );
        if (!membro) return res.status(404).json({ error: 'Membro não encontrado.' });

        if (membro.jovem_id) {
            const [[conflito]] = await pool.query(
                `SELECT mm.id, mm.equipe_id, mm.funcao_id, e.nome AS equipe_nome, ef.nome AS funcao_nome
                 FROM montagem_membros mm
                 JOIN equipes e ON e.id = mm.equipe_id
                 LEFT JOIN equipes_funcoes ef ON ef.id = mm.funcao_id
                 WHERE mm.montagem_id = ?
                   AND mm.jovem_id = ?
                   AND mm.eh_substituicao = 0
                   AND mm.id <> ?
                   AND mm.tenant_id = ?
                 LIMIT 1`,
                [membro.montagem_id, membro.jovem_id, membroId, tenantId]
            );
            if (conflito && !forcar) {
                return res.status(409).json({
                    error: `Esse jovem já está na equipe ${conflito.equipe_nome} como função ${conflito.funcao_nome || '-'}. Deseja trocar mesmo assim?`,
                    conflict: conflito
                });
            }
            if (conflito && forcar) {
                await pool.query(
                    'UPDATE montagem_membros SET eh_substituicao = 1 WHERE id = ? AND tenant_id = ?',
                    [conflito.id, tenantId]
                );
                if (membro.montagem_id && membro.jovem_id && conflito) {
                    await removerHistoricoDaAlocacao({
                        montagemId: membro.montagem_id,
                        equipeId: conflito.equipe_id || membro.equipe_id,
                        funcaoId: conflito.funcao_id || membro.funcao_id,
                        jovemId: membro.jovem_id,
                        tenantId
                    });
                }
            }
        }

        const [r] = await pool.query('UPDATE montagem_membros SET eh_substituicao = 0 WHERE id = ? AND tenant_id = ?', [membroId, tenantId]);
        if (!r.affectedRows) return res.status(404).json({ error: 'Membro não encontrado.' });
        if (membro.montagem_id && membro.equipe_id && membro.funcao_id && membro.jovem_id) {
            await sincronizarHistoricoDaAlocacao({
                montagemId: membro.montagem_id,
                equipeId: membro.equipe_id,
                funcaoId: membro.funcao_id,
                jovemId: membro.jovem_id,
                tenantId
            });
        }
        return res.json({ message: 'Membro movido para titular.' });
    } catch (err) {
        console.error('Erro ao mover substituição para titular:', err);
        return res.status(500).json({ error: 'Erro ao mover para titular.' });
    }
});

router.patch('/membro/:membroId/remover-recusa', async (req, res) => {
    const membroId = Number(req.params.membroId);
    if (!membroId) return res.status(400).json({ error: 'ID inválido.' });
    try {
        const tenantId = getTenantId(req);
        await garantirEstruturaMontagemMembrosExtra();
        const [[membro]] = await pool.query(`
            SELECT mm.id, mm.jovem_id, mm.status_ligacao, mm.montagem_id, mm.equipe_id, mm.funcao_id,
                   m.numero_ejc, e.nome AS equipe_nome
            FROM montagem_membros mm
            JOIN montagens m ON m.id = mm.montagem_id
            LEFT JOIN equipes e ON e.id = mm.equipe_id
            WHERE mm.id = ? AND mm.tenant_id = ?
            LIMIT 1
        `, [membroId, tenantId]);
        if (!membro) return res.status(404).json({ error: 'Membro não encontrado.' });
        if (String(membro.status_ligacao || '').toUpperCase() !== 'RECUSOU') {
            return res.status(400).json({ error: 'Este membro não está marcado como recusou.' });
        }

        if (membro.jovem_id && membro.montagem_id && membro.equipe_id && membro.funcao_id) {
            await removerHistoricoDaAlocacao({
                montagemId: membro.montagem_id,
                equipeId: membro.equipe_id,
                funcaoId: membro.funcao_id,
                jovemId: membro.jovem_id,
                tenantId
            });
        }
        if (membro.jovem_id && membro.numero_ejc && membro.equipe_nome) {
            const edicaoMontagem = montarEtiquetaEdicao(membro.numero_ejc);
            await pool.query(
                `DELETE FROM historico_equipes
                 WHERE jovem_id = ?
                   AND tenant_id = ?
                   AND equipe = ?
                   AND (edicao_ejc <=> ?)`,
                [membro.jovem_id, tenantId, membro.equipe_nome, edicaoMontagem]
            );
        }

        await pool.query('DELETE FROM montagem_membros WHERE id = ? AND tenant_id = ?', [membroId, tenantId]);

        if (membro.jovem_id && membro.numero_ejc) {
            const likeTexto = `Jovem recusou servir no ${membro.numero_ejc}º encontro de montagem.%`;
            await pool.query(
                `DELETE FROM jovens_observacoes
                 WHERE jovem_id = ? AND tenant_id = ? AND texto LIKE ?
                 ORDER BY id DESC
                 LIMIT 1`,
                [membro.jovem_id, tenantId, likeTexto]
            );
        }

        return res.json({ message: 'Recusa removida e jovem retirado da equipe.' });
    } catch (err) {
        console.error('Erro ao remover recusa:', err);
        return res.status(500).json({ error: 'Erro ao remover recusa.' });
    }
});

router.get('/:id/exportar-equipes-excel', async (req, res) => {
    const montagemId = Number(req.params.id);
    if (!montagemId) return res.status(400).json({ error: 'ID inválido.' });
    try {
        const tenantId = getTenantId(req);
        await garantirEstruturaMontagemMembrosExtra();
        const temTabelaTios = await hasTable('tios_casais');
        const tioJoin = temTabelaTios
            ? `LEFT JOIN tios_casais tc
                 ON tc.tenant_id = mm.tenant_id
                AND TRIM(CONCAT(COALESCE(tc.nome_tio, ''), ' e ', COALESCE(tc.nome_tia, ''))) = TRIM(COALESCE(mm.nome_externo, ''))`
            : '';
        const [rows] = await pool.query(`
            SELECT
                e.nome AS equipe_nome,
                COALESCE(j.nome_completo, mm.nome_externo) AS nome,
                COALESCE(j.telefone, mm.telefone_externo, tc.telefone_tio, tc.telefone_tia) AS telefone,
                mm.status_ligacao,
                CASE
                    WHEN j.data_nascimento IS NULL THEN NULL
                    ELSE TIMESTAMPDIFF(YEAR, j.data_nascimento, CURDATE())
                END AS idade,
                COALESCE(j.origem_ejc_tipo, 'INCONFIDENTES') AS origem_ejc_tipo,
                j.numero_ejc_fez,
                j.outro_ejc_numero,
                oe.nome AS outro_ejc_nome,
                oe.paroquia AS outro_ejc_paroquia
            FROM montagem_membros mm
            JOIN equipes e ON e.id = mm.equipe_id
            LEFT JOIN jovens j ON j.id = mm.jovem_id
            LEFT JOIN outros_ejcs oe ON oe.id = j.outro_ejc_id
            ${tioJoin}
            WHERE mm.montagem_id = ?
              AND mm.tenant_id = ?
              AND COALESCE(j.nome_completo, mm.nome_externo) IS NOT NULL
            ORDER BY e.nome ASC, nome ASC
        `, [montagemId, tenantId]);
        return res.json(rows || []);
    } catch (err) {
        console.error('Erro ao buscar dados para exportar equipes:', err);
        return res.status(500).json({ error: 'Erro ao gerar arquivo.' });
    }
});

// Remover jovem da função
router.delete('/membro/:membroId', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const [[dadosMembro]] = await pool.query(`
            SELECT mm.id, mm.jovem_id, mm.equipe_id, mm.funcao_id, m.numero_ejc, e.nome AS equipe_nome,
                   ef.nome AS funcao_nome, COALESCE(ef.papel_base, 'Membro') AS papel_base
            FROM montagem_membros mm
            JOIN montagens m ON m.id = mm.montagem_id
            JOIN equipes e ON e.id = mm.equipe_id
            JOIN equipes_funcoes ef ON ef.id = mm.funcao_id
            WHERE mm.id = ? AND mm.tenant_id = ?
            LIMIT 1
        `, [req.params.membroId, tenantId]);

        if (!dadosMembro) {
            return res.status(404).json({ error: "Membro não encontrado na montagem." });
        }

        await pool.query('DELETE FROM montagem_membros WHERE id = ? AND tenant_id = ?', [req.params.membroId, tenantId]);

        const comSubfuncao = await hasSubfuncaoColumn();
        const edicaoMontagem = montarEtiquetaEdicao(dadosMembro.numero_ejc);
        const papelMapeado = dadosMembro.papel_base || mapearPapelPorNomeFuncao(dadosMembro.funcao_nome);
        if (comSubfuncao) {
            await pool.query(
                `DELETE FROM historico_equipes
                 WHERE jovem_id = ?
                   AND equipe = ?
                   AND papel = ?
                   AND (subfuncao <=> ?)
                   AND (edicao_ejc <=> ?)
                 ORDER BY id DESC
                 LIMIT 1`,
                [dadosMembro.jovem_id, dadosMembro.equipe_nome, papelMapeado, dadosMembro.funcao_nome || null, edicaoMontagem]
            );
        } else {
            await pool.query(
                `DELETE FROM historico_equipes
                 WHERE jovem_id = ?
                  AND equipe = ?
                  AND papel = ?
                  AND (edicao_ejc <=> ?)
                 ORDER BY id DESC
                 LIMIT 1`,
                [dadosMembro.jovem_id, dadosMembro.equipe_nome, papelMapeado, edicaoMontagem]
            );
        }
        if (dadosMembro.jovem_id && dadosMembro.equipe_nome) {
            await pool.query(
                `DELETE FROM historico_equipes
                 WHERE jovem_id = ?
                   AND tenant_id = ?
                   AND equipe = ?
                   AND (edicao_ejc <=> ?)`,
                [dadosMembro.jovem_id, tenantId, dadosMembro.equipe_nome, edicaoMontagem]
            );
        }

        res.json({ message: "Jovem removido com sucesso" });
    } catch (err) {
        console.error("Erro ao remover membro:", err);
        res.status(500).json({ error: "Erro ao remover jovem" });
    }
});

router.finalizarEncontroHandler = finalizarEncontroHandler;
module.exports = router;
