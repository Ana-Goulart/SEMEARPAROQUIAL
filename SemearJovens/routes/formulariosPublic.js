const express = require('express');
const { pool } = require('../database');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const router = express.Router();

let estruturaGarantida = false;
let estruturaPromise = null;

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

async function getColumnType(tableName, columnName) {
    const [rows] = await pool.query(`
        SELECT DATA_TYPE AS data_type
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
        LIMIT 1
    `, [tableName, columnName]);
    return rows && rows[0] ? String(rows[0].data_type || '').toLowerCase() : null;
}

function normalizeDate(v) {
    if (!v) return null;
    const txt = String(v).trim();
    if (!txt) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(txt)) return txt;
    const br = txt.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/);
    if (br) return `${br[3]}-${br[2]}-${br[1]}`;
    if (txt.includes('T')) return txt.split('T')[0];
    return null;
}

function normalizePhoneDigits(v) {
    return String(v || '').replace(/\D/g, '');
}

async function ensureJovensTermosColumns() {
    const hasEmail = await hasColumn('jovens', 'email');
    if (!hasEmail) {
        await runAlterIgnoreDuplicate('ALTER TABLE jovens ADD COLUMN email VARCHAR(180) NULL AFTER telefone');
    }
    const hasTermosEm = await hasColumn('jovens', 'termos_aceitos_em');
    if (!hasTermosEm) {
        await runAlterIgnoreDuplicate('ALTER TABLE jovens ADD COLUMN termos_aceitos_em DATETIME NULL AFTER email');
    }
    const hasTermosEmail = await hasColumn('jovens', 'termos_aceitos_email');
    if (!hasTermosEmail) {
        await runAlterIgnoreDuplicate('ALTER TABLE jovens ADD COLUMN termos_aceitos_email VARCHAR(180) NULL AFTER termos_aceitos_em');
    }
}

async function runAlterIgnoreDuplicate(sql) {
    try {
        await pool.query(sql);
    } catch (err) {
        if (err && (err.code === 'ER_DUP_FIELDNAME' || err.code === 'ER_DUP_KEYNAME')) return;
        if (err && err.code === 'ER_BAD_FIELD_ERROR' && /\sAFTER\s/i.test(sql)) {
            const fallbackSql = sql.replace(/\s+AFTER\s+[a-zA-Z0-9_`]+/i, '');
            try {
                await pool.query(fallbackSql);
                return;
            } catch (fallbackErr) {
                if (fallbackErr && (fallbackErr.code === 'ER_DUP_FIELDNAME' || fallbackErr.code === 'ER_DUP_KEYNAME')) return;
                throw fallbackErr;
            }
        }
        throw err;
    }
}

async function garantirEstrutura() {
    if (estruturaGarantida) return;
    if (estruturaPromise) {
        await estruturaPromise;
        return;
    }

    estruturaPromise = (async () => {
        await pool.query(`
        CREATE TABLE IF NOT EXISTS formularios_pastas (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            nome VARCHAR(160) NOT NULL,
            parent_id INT NULL,
            criado_por INT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
        `);

        await pool.query(`
        CREATE TABLE IF NOT EXISTS formularios_itens (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            titulo VARCHAR(180) NOT NULL,
            tema VARCHAR(200) NULL,
            tipo VARCHAR(40) NOT NULL DEFAULT 'LISTA_PRESENCA',
            token VARCHAR(80) NOT NULL UNIQUE,
            pasta_id INT NULL,
            evento_data DATE NULL,
            evento_hora TIME NULL,
            criar_lista_presenca TINYINT(1) NOT NULL DEFAULT 1,
            usar_lista_jovens TINYINT(1) NOT NULL DEFAULT 1,
            coletar_dados_avulsos TINYINT(1) NOT NULL DEFAULT 0,
            permitir_ja_fez_ejc TINYINT(1) NOT NULL DEFAULT 1,
            permitir_nao_fez_ejc TINYINT(1) NOT NULL DEFAULT 1,
            pergunta_texto_obrigatoria VARCHAR(220) NULL,
            criado_por INT NULL,
            ativo TINYINT(1) NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
        `);

        await pool.query(`
        CREATE TABLE IF NOT EXISTS formularios_presencas (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            formulario_id INT NOT NULL,
            jovem_id INT NULL,
            nome_completo VARCHAR(180) NULL,
            telefone VARCHAR(30) NULL,
            ejc_origem VARCHAR(140) NULL,
            status_ejc VARCHAR(20) NULL,
            origem_ja_fez VARCHAR(20) NULL,
            outro_ejc_id INT NULL,
            resposta_texto_obrigatoria VARCHAR(255) NULL,
            registrado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            ip VARCHAR(64) NULL,
            user_agent VARCHAR(255) NULL,
            UNIQUE KEY uniq_formulario_jovem (formulario_id, jovem_id)
        )
        `);

        await pool.query(`
        CREATE TABLE IF NOT EXISTS formularios_respostas (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            formulario_id INT NOT NULL,
            nome_referencia VARCHAR(180) NULL,
            telefone_referencia VARCHAR(30) NULL,
            resposta_json LONGTEXT NOT NULL,
            registrado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            ip VARCHAR(64) NULL,
            user_agent VARCHAR(255) NULL
        )
        `);

        const comEventoData = await hasColumn('formularios_itens', 'evento_data');
        if (!comEventoData) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_itens ADD COLUMN evento_data DATE NULL AFTER pasta_id');
        }
        const comEventoHora = await hasColumn('formularios_itens', 'evento_hora');
        if (!comEventoHora) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_itens ADD COLUMN evento_hora TIME NULL AFTER evento_data');
        }
        const comTema = await hasColumn('formularios_itens', 'tema');
        if (!comTema) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_itens ADD COLUMN tema VARCHAR(200) NULL AFTER titulo');
        }
        const comDescricao = await hasColumn('formularios_itens', 'descricao');
        if (!comDescricao) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_itens ADD COLUMN descricao TEXT NULL AFTER tema');
        }
        const comCriarLista = await hasColumn('formularios_itens', 'criar_lista_presenca');
        if (!comCriarLista) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_itens ADD COLUMN criar_lista_presenca TINYINT(1) NOT NULL DEFAULT 1 AFTER evento_hora');
        }
        const comUsarListaJovens = await hasColumn('formularios_itens', 'usar_lista_jovens');
        if (!comUsarListaJovens) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_itens ADD COLUMN usar_lista_jovens TINYINT(1) NOT NULL DEFAULT 1 AFTER evento_hora');
        }
        const comColetarDadosAvulsos = await hasColumn('formularios_itens', 'coletar_dados_avulsos');
        if (!comColetarDadosAvulsos) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_itens ADD COLUMN coletar_dados_avulsos TINYINT(1) NOT NULL DEFAULT 0 AFTER usar_lista_jovens');
        }
        const comPermitirJaFez = await hasColumn('formularios_itens', 'permitir_ja_fez_ejc');
        if (!comPermitirJaFez) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_itens ADD COLUMN permitir_ja_fez_ejc TINYINT(1) NOT NULL DEFAULT 1 AFTER coletar_dados_avulsos');
        }
        const comPermitirNaoFez = await hasColumn('formularios_itens', 'permitir_nao_fez_ejc');
        if (!comPermitirNaoFez) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_itens ADD COLUMN permitir_nao_fez_ejc TINYINT(1) NOT NULL DEFAULT 1 AFTER permitir_ja_fez_ejc');
        }
        const comPermitirEcc = await hasColumn('formularios_itens', 'permitir_ecc_ecna');
        if (!comPermitirEcc) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_itens ADD COLUMN permitir_ecc_ecna TINYINT(1) NOT NULL DEFAULT 0 AFTER permitir_nao_fez_ejc');
        }
        const comPermitirVisitante = await hasColumn('formularios_itens', 'permitir_visitante');
        if (!comPermitirVisitante) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_itens ADD COLUMN permitir_visitante TINYINT(1) NOT NULL DEFAULT 1 AFTER permitir_ecc_ecna');
        }
        const comPerguntaTextoObrigatoria = await hasColumn('formularios_itens', 'pergunta_texto_obrigatoria');
        if (!comPerguntaTextoObrigatoria) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_itens ADD COLUMN pergunta_texto_obrigatoria VARCHAR(220) NULL AFTER permitir_nao_fez_ejc');
        }
        const comCamposConfig = await hasColumn('formularios_itens', 'campos_config_json');
        if (!comCamposConfig) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_itens ADD COLUMN campos_config_json LONGTEXT NULL AFTER pergunta_texto_obrigatoria');
        }
        const comVisualConfig = await hasColumn('formularios_itens', 'visual_config_json');
        if (!comVisualConfig) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_itens ADD COLUMN visual_config_json LONGTEXT NULL AFTER campos_config_json');
        }
        const comLinkInicio = await hasColumn('formularios_itens', 'link_inicio_hora');
        if (!comLinkInicio) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_itens ADD COLUMN link_inicio_hora TIME NULL AFTER permitir_nao_fez_ejc');
        } else {
            const tipoLinkInicio = await getColumnType('formularios_itens', 'link_inicio_hora');
            if (tipoLinkInicio && tipoLinkInicio !== 'time') {
                await pool.query('ALTER TABLE formularios_itens MODIFY COLUMN link_inicio_hora TIME NULL');
            }
        }
        const comLinkFim = await hasColumn('formularios_itens', 'link_fim_hora');
        if (!comLinkFim) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_itens ADD COLUMN link_fim_hora TIME NULL AFTER link_inicio_hora');
        } else {
            const tipoLinkFim = await getColumnType('formularios_itens', 'link_fim_hora');
            if (tipoLinkFim && tipoLinkFim !== 'time') {
                await pool.query('ALTER TABLE formularios_itens MODIFY COLUMN link_fim_hora TIME NULL');
            }
        }
        const comTenantPastas = await hasColumn('formularios_pastas', 'tenant_id');
        if (!comTenantPastas) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_pastas ADD COLUMN tenant_id INT NULL AFTER id');
        }
        const comTenantItens = await hasColumn('formularios_itens', 'tenant_id');
        if (!comTenantItens) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_itens ADD COLUMN tenant_id INT NULL AFTER id');
        }
        const comTenantPresencas = await hasColumn('formularios_presencas', 'tenant_id');
        if (!comTenantPresencas) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_presencas ADD COLUMN tenant_id INT NULL AFTER id');
        }
        const comTenantRespostas = await hasColumn('formularios_respostas', 'tenant_id');
        if (!comTenantRespostas) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_respostas ADD COLUMN tenant_id INT NULL AFTER id');
        }

        const comNomeCompleto = await hasColumn('formularios_presencas', 'nome_completo');
        if (!comNomeCompleto) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_presencas ADD COLUMN nome_completo VARCHAR(180) NULL AFTER jovem_id');
        }
        const comTelefone = await hasColumn('formularios_presencas', 'telefone');
        if (!comTelefone) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_presencas ADD COLUMN telefone VARCHAR(30) NULL AFTER nome_completo');
        }
        const comEjcOrigem = await hasColumn('formularios_presencas', 'ejc_origem');
        if (!comEjcOrigem) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_presencas ADD COLUMN ejc_origem VARCHAR(140) NULL AFTER telefone');
        }
        const comStatusEjc = await hasColumn('formularios_presencas', 'status_ejc');
        if (!comStatusEjc) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_presencas ADD COLUMN status_ejc VARCHAR(20) NULL AFTER ejc_origem');
        }
        const comOrigemJaFez = await hasColumn('formularios_presencas', 'origem_ja_fez');
        if (!comOrigemJaFez) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_presencas ADD COLUMN origem_ja_fez VARCHAR(20) NULL AFTER status_ejc');
        }
        const comOutroEjcId = await hasColumn('formularios_presencas', 'outro_ejc_id');
        if (!comOutroEjcId) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_presencas ADD COLUMN outro_ejc_id INT NULL AFTER origem_ja_fez');
        }
        const comTipoParticipante = await hasColumn('formularios_presencas', 'tipo_participante');
        if (!comTipoParticipante) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_presencas ADD COLUMN tipo_participante VARCHAR(20) NULL AFTER outro_ejc_id');
        }
        const comEccTipo = await hasColumn('formularios_presencas', 'ecc_tipo');
        if (!comEccTipo) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_presencas ADD COLUMN ecc_tipo VARCHAR(10) NULL AFTER tipo_participante');
        }
        const comEccId = await hasColumn('formularios_presencas', 'ecc_id');
        if (!comEccId) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_presencas ADD COLUMN ecc_id INT NULL AFTER ecc_tipo');
        }
        const comTioCasalId = await hasColumn('formularios_presencas', 'tio_casal_id');
        if (!comTioCasalId) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_presencas ADD COLUMN tio_casal_id INT NULL AFTER ecc_id');
        }
        const comRespostaTextoObrigatoria = await hasColumn('formularios_presencas', 'resposta_texto_obrigatoria');
        if (!comRespostaTextoObrigatoria) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_presencas ADD COLUMN resposta_texto_obrigatoria VARCHAR(255) NULL AFTER outro_ejc_id');
        }
        const comEmailPresenca = await hasColumn('formularios_presencas', 'email');
        if (!comEmailPresenca) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_presencas ADD COLUMN email VARCHAR(180) NULL AFTER telefone');
        }
        const comTermosPresenca = await hasColumn('formularios_presencas', 'termos_aceitos_em');
        if (!comTermosPresenca) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_presencas ADD COLUMN termos_aceitos_em DATETIME NULL AFTER email');
        }
        const comRespostaJsonPresenca = await hasColumn('formularios_presencas', 'resposta_json');
        if (!comRespostaJsonPresenca) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_presencas ADD COLUMN resposta_json LONGTEXT NULL AFTER resposta_texto_obrigatoria');
        }

        const comEmailResposta = await hasColumn('formularios_respostas', 'email');
        if (!comEmailResposta) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_respostas ADD COLUMN email VARCHAR(180) NULL AFTER telefone_referencia');
        }
        const comTermosResposta = await hasColumn('formularios_respostas', 'termos_aceitos_em');
        if (!comTermosResposta) {
            await runAlterIgnoreDuplicate('ALTER TABLE formularios_respostas ADD COLUMN termos_aceitos_em DATETIME NULL AFTER email');
        }
        const [jovemCol] = await pool.query(`
        SELECT IS_NULLABLE AS is_nullable
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'formularios_presencas'
          AND COLUMN_NAME = 'jovem_id'
        LIMIT 1
        `);
        if (jovemCol.length && String(jovemCol[0].is_nullable || '').toUpperCase() !== 'YES') {
            await pool.query('ALTER TABLE formularios_presencas MODIFY COLUMN jovem_id INT NULL');
        }

        estruturaGarantida = true;
    })();

    try {
        await estruturaPromise;
    } finally {
        estruturaPromise = null;
    }
}

function toPositiveInt(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function toBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    const txt = String(value || '').trim().toLowerCase();
    return txt === '1' || txt === 'true' || txt === 'sim' || txt === 'yes' || txt === 'on';
}

function normalizePhoneDigits(value) {
    return String(value || '').replace(/\D/g, '');
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

function sanitizeCampoTipo(value) {
    const tipo = String(value || '').trim().toLowerCase();
    const allowed = new Set(['texto', 'textarea', 'telefone', 'email', 'data', 'numero', 'select', 'radio', 'checkbox', 'imagem', 'arquivo']);
    return allowed.has(tipo) ? tipo : 'texto';
}

function sanitizeCamposConfig(value) {
    const raw = Array.isArray(value) ? value : parseJsonSafe(value, []);
    if (!Array.isArray(raw)) return [];
    const out = [];
    const ids = new Set();

    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const label = String(item.label || item.titulo || '').trim().slice(0, 180);
        if (!label) continue;
        const baseId = String(item.id || label)
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 60) || `campo_${out.length + 1}`;
        let finalId = baseId;
        let seq = 2;
        while (ids.has(finalId)) {
            finalId = `${baseId}_${seq}`;
            seq += 1;
        }
        ids.add(finalId);
        const tipo = sanitizeCampoTipo(item.tipo);
        let opcoes = Array.isArray(item.opcoes) ? item.opcoes : parseJsonSafe(item.opcoes, []);
        if (!Array.isArray(opcoes)) opcoes = [];
        opcoes = opcoes
            .map((op) => String(op || '').trim().slice(0, 120))
            .filter(Boolean)
            .slice(0, 30);

        out.push({
            id: finalId,
            label,
            tipo,
            obrigatorio: !!item.obrigatorio,
            placeholder: String(item.placeholder || '').trim().slice(0, 140) || null,
            opcoes: ['select', 'radio', 'checkbox'].includes(tipo) ? opcoes : []
        });
    }
    return out;
}

function normalizeFormResponses(camposConfig, respostasRaw) {
    const respostas = parseJsonSafe(respostasRaw, {});
    if (!respostas || typeof respostas !== 'object' || Array.isArray(respostas)) {
        return { error: 'Respostas inválidas.' };
    }

    const respostaFinal = {};
    for (const campo of camposConfig) {
        const valorBruto = respostas[campo.id];
        let valor = valorBruto;

        if (campo.tipo === 'checkbox') {
            const arr = Array.isArray(valorBruto) ? valorBruto : (valorBruto ? [valorBruto] : []);
            valor = arr.map((v) => String(v || '').trim()).filter(Boolean);
            if (campo.opcoes.length) {
                valor = valor.filter((v) => campo.opcoes.includes(v));
            }
            if (campo.obrigatorio && !valor.length) {
                return { error: `Preencha o campo obrigatório: ${campo.label}.` };
            }
        } else {
            valor = String(valorBruto || '').trim();
            if (campo.obrigatorio && !valor) {
                return { error: `Preencha o campo obrigatório: ${campo.label}.` };
            }
            if (valor && (campo.tipo === 'select' || campo.tipo === 'radio') && campo.opcoes.length && !campo.opcoes.includes(valor)) {
                return { error: `Valor inválido no campo: ${campo.label}.` };
            }
        }

        respostaFinal[campo.id] = valor;
    }

    return {
        respostaFinal,
        payload: {
            campos: camposConfig.map((campo) => ({
                id: campo.id,
                label: campo.label,
                tipo: campo.tipo,
                valor: respostaFinal[campo.id]
            }))
        }
    };
}

function sanitizeHexColor(value, fallback) {
    const txt = String(value || '').trim();
    if (!txt) return fallback;
    const match = txt.match(/^#([0-9a-fA-F]{6})$/);
    if (!match) return fallback;
    return `#${match[1].toUpperCase()}`;
}

function sanitizeVisualConfig(value) {
    const raw = (value && typeof value === 'object') ? value : parseJsonSafe(value, {});
    const obj = raw && typeof raw === 'object' ? raw : {};
    const fonte = String(obj.fonte || '').trim().toLowerCase();
    const fonteFinal = ['sans', 'serif', 'mono'].includes(fonte) ? fonte : 'sans';
    const rounded = obj.rounded_cards === undefined ? true : toBoolean(obj.rounded_cards);
    const compact = obj.compact_layout === undefined ? false : toBoolean(obj.compact_layout);
    return {
        cor_primaria: sanitizeHexColor(obj.cor_primaria, '#0EA5E9'),
        cor_fundo: sanitizeHexColor(obj.cor_fundo, '#F1F5F9'),
        cor_texto: sanitizeHexColor(obj.cor_texto, '#0F172A'),
        cor_card: sanitizeHexColor(obj.cor_card, '#FFFFFF'),
        fonte: fonteFinal,
        rounded_cards: rounded,
        compact_layout: compact
    };
}

function parseDbTimeToSeconds(value) {
    if (!value) return null;
    let txt = String(value).trim();
    if (!txt) return null;
    if (txt.includes(' ')) txt = txt.split(' ')[1] || '';
    if (txt.includes('T')) txt = txt.split('T')[1] || '';
    if (!txt) return null;
    const parts = txt.split(':');
    if (parts.length < 2) return null;
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    const s = Number(parts[2] || 0);
    if (!Number.isInteger(h) || !Number.isInteger(m) || !Number.isInteger(s)) return null;
    if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) return null;
    return (h * 3600) + (m * 60) + s;
}

function isLinkDisponivel(form) {
    const now = new Date();
    const agoraSegundos = (now.getHours() * 3600) + (now.getMinutes() * 60) + now.getSeconds();
    const inicio = parseDbTimeToSeconds(form && form.link_inicio_hora);
    const fim = parseDbTimeToSeconds(form && form.link_fim_hora);
    if (inicio !== null && agoraSegundos < inicio) return false;
    if (fim !== null && agoraSegundos > fim) return false;
    return true;
}

const storage = multer.diskStorage({
    destination: function (_req, _file, cb) {
        const uploadDir = path.join('public', 'uploads', 'formularios');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (_req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const safe = String(file.originalname || '').replace(/[^a-zA-Z0-9.-]/g, '_');
        cb(null, `${uniqueSuffix}-${safe}`);
    }
});
const upload = multer({
    storage,
    fileFilter: (_req, file, cb) => {
        if (file && typeof file.mimetype === 'string' && file.mimetype.startsWith('image/')) {
            return cb(null, true);
        }
        return cb(new Error('Tipo de arquivo inválido. Envie uma imagem.'));
    }
});

async function getMeuEjcNome(tenantId) {
    if (!tenantId) return 'Inconfidentes';
    try {
        const [tenantRows] = await pool.query(
            'SELECT nome_ejc AS nome FROM tenants_ejc WHERE id = ? LIMIT 1',
            [tenantId]
        );
        if (tenantRows && tenantRows.length && tenantRows[0].nome) return tenantRows[0].nome;
    } catch (_) {
        // ignore
    }
    try {
        const [rows] = await pool.query('SELECT nome FROM meu_ejc_config WHERE id = 1 LIMIT 1');
        if (rows && rows.length && rows[0].nome) return rows[0].nome;
    } catch (_) {
        // ignore
    }
    return 'Inconfidentes';
}

// GET /api/formularios/public/:token/outro-ejc-jovens
router.get('/:token/outro-ejc-jovens', async (req, res) => {
    try {
        await garantirEstrutura();
        const token = String(req.params.token || '').trim();
        const outroEjcId = toPositiveInt(req.query.outro_ejc_id);
        if (!token) return res.status(400).json({ error: 'Token inválido.' });

        const [forms] = await pool.query(
            `SELECT id, ativo, permitir_ja_fez_ejc, tenant_id, link_inicio_hora, link_fim_hora
             FROM formularios_itens
             WHERE token = ?
             LIMIT 1`,
            [token]
        );
        if (!forms.length || !forms[0].ativo) return res.status(404).json({ error: 'Formulário não encontrado.' });
        const tenantId = Number(forms[0].tenant_id || 0);
        if (!tenantId) return res.status(400).json({ error: 'Tenant inválido no formulário.' });
        if (!isLinkDisponivel(forms[0])) {
            return res.status(403).json({ error: 'Este link está fora do período de disponibilidade.' });
        }
        if (Number(forms[0].permitir_ja_fez_ejc) !== 1) return res.json([]);

        const hasOutrosEjcs = await hasTable('outros_ejcs');
        const params = [tenantId];
        let whereOutroEjc = '';
        if (outroEjcId) {
            whereOutroEjc = 'AND fp.outro_ejc_id = ?';
            params.push(outroEjcId);
        }

        const [rowsHistorico] = await pool.query(`
            SELECT
                MAX(fp.id) AS id,
                fp.nome_completo,
                fp.telefone,
                fp.outro_ejc_id,
                MAX(fp.registrado_em) AS ultimo_registro
                ${hasOutrosEjcs ? ', oe.nome AS outro_ejc_nome, oe.paroquia AS outro_ejc_paroquia' : ", NULL AS outro_ejc_nome, NULL AS outro_ejc_paroquia"}
            FROM formularios_presencas fp
            ${hasOutrosEjcs ? 'LEFT JOIN outros_ejcs oe ON oe.id = fp.outro_ejc_id AND oe.tenant_id = fp.tenant_id' : ''}
            WHERE fp.tenant_id = ?
              AND fp.status_ejc = 'JA_FIZ'
              AND fp.origem_ja_fez = 'OUTRO_EJC'
              AND COALESCE(TRIM(fp.nome_completo), '') <> ''
              AND COALESCE(TRIM(fp.telefone), '') <> ''
              ${whereOutroEjc}
            GROUP BY fp.nome_completo, fp.telefone, fp.outro_ejc_id
                     ${hasOutrosEjcs ? ', oe.nome, oe.paroquia' : ''}
            ORDER BY fp.nome_completo ASC
        `, params);

        const [rowsCadastro] = await pool.query(`
            SELECT
                j.id,
                j.nome_completo,
                j.telefone,
                j.outro_ejc_id,
                NULL AS ultimo_registro
                ${hasOutrosEjcs ? ', oe.nome AS outro_ejc_nome, oe.paroquia AS outro_ejc_paroquia' : ", NULL AS outro_ejc_nome, NULL AS outro_ejc_paroquia"}
            FROM jovens j
            ${hasOutrosEjcs ? 'LEFT JOIN outros_ejcs oe ON oe.id = j.outro_ejc_id AND oe.tenant_id = j.tenant_id' : ''}
            WHERE j.tenant_id = ?
              AND COALESCE(j.origem_ejc_tipo, 'INCONFIDENTES') = 'OUTRO_EJC'
              AND COALESCE(TRIM(j.nome_completo), '') <> ''
              AND COALESCE(TRIM(j.telefone), '') <> ''
              ${outroEjcId ? 'AND j.outro_ejc_id = ?' : ''}
            ORDER BY j.nome_completo ASC
        `, outroEjcId ? [tenantId, outroEjcId] : [tenantId]);

        const mapa = new Map();
        const normalizarChave = (nome, telefone, outroId) => `${String(nome || '').trim().toLowerCase()}|${String(telefone || '').replace(/\D/g, '')}|${Number(outroId || 0)}`;

        for (const r of rowsCadastro || []) {
            const chave = normalizarChave(r.nome_completo, r.telefone, r.outro_ejc_id);
            mapa.set(chave, {
                id: `J:${r.id}`,
                referencia: `J:${r.id}`,
                origem_registro: 'CADASTRO',
                nome_completo: r.nome_completo,
                telefone: r.telefone,
                outro_ejc_id: r.outro_ejc_id,
                outro_ejc_nome: r.outro_ejc_nome,
                outro_ejc_paroquia: r.outro_ejc_paroquia,
                ultimo_registro: null
            });
        }

        for (const r of rowsHistorico || []) {
            const chave = normalizarChave(r.nome_completo, r.telefone, r.outro_ejc_id);
            if (mapa.has(chave)) continue;
            mapa.set(chave, {
                id: `H:${r.id}`,
                referencia: `H:${r.id}`,
                origem_registro: 'HISTORICO',
                nome_completo: r.nome_completo,
                telefone: r.telefone,
                outro_ejc_id: r.outro_ejc_id,
                outro_ejc_nome: r.outro_ejc_nome,
                outro_ejc_paroquia: r.outro_ejc_paroquia,
                ultimo_registro: r.ultimo_registro
            });
        }

        const lista = Array.from(mapa.values()).sort((a, b) => String(a.nome_completo || '').localeCompare(String(b.nome_completo || ''), 'pt-BR'));
        return res.json(lista);
    } catch (err) {
        console.error('Erro ao listar jovens de outro EJC:', err);
        return res.status(500).json({ error: 'Erro ao buscar jovens de outro EJC.' });
    }
});

// GET /api/formularios/public/:token/tios?ecc_id=1&origem_tipo=EJC
router.get('/:token/tios', async (req, res) => {
    try {
        await garantirEstrutura();
        const token = String(req.params.token || '').trim();
        const eccId = toPositiveInt(req.query.ecc_id);
        const outroEjcId = toPositiveInt(req.query.outro_ejc_id);
        const origemTipo = String(req.query.origem_tipo || 'EJC').trim().toUpperCase() === 'OUTRO_EJC' ? 'OUTRO_EJC' : 'EJC';
        if (!token) return res.status(400).json({ error: 'Token inválido.' });

        const [forms] = await pool.query(
            `SELECT id, ativo, tenant_id, link_inicio_hora, link_fim_hora, permitir_ecc_ecna
             FROM formularios_itens
             WHERE token = ?
             LIMIT 1`,
            [token]
        );
        if (!forms.length || !forms[0].ativo) return res.status(404).json({ error: 'Formulário não encontrado.' });
        if (!isLinkDisponivel(forms[0])) {
            return res.status(403).json({ error: 'Este link está fora do período de disponibilidade.' });
        }
        if (Number(forms[0].permitir_ecc_ecna) !== 1) return res.json([]);
        const tenantId = Number(forms[0].tenant_id || 0);
        if (!tenantId) return res.status(400).json({ error: 'Tenant inválido no formulário.' });

        const hasTiosCasais = await hasTable('tios_casais');
        if (!hasTiosCasais) return res.json([]);

        let rows = [];
        if (origemTipo === 'OUTRO_EJC') {
            if (!outroEjcId) return res.status(400).json({ error: 'Outro EJC inválido.' });
            const [outroRows] = await pool.query(
                'SELECT id FROM outros_ejcs WHERE id = ? AND tenant_id = ? LIMIT 1',
                [outroEjcId, tenantId]
            );
            if (!outroRows.length) return res.status(400).json({ error: 'Outro EJC inválido.' });
            [rows] = await pool.query(
                `SELECT id, nome_tio, nome_tia
                 FROM tios_casais
                 WHERE tenant_id = ?
                   AND COALESCE(origem_tipo, 'EJC') = 'OUTRO_EJC'
                   AND outro_ejc_id = ?
                 ORDER BY nome_tio ASC, nome_tia ASC`,
                [tenantId, outroEjcId]
            );
        } else {
            if (!eccId) return res.status(400).json({ error: 'Encontro inválido.' });
            [rows] = await pool.query(
                `SELECT id, nome_tio, nome_tia
                 FROM tios_casais
                 WHERE tenant_id = ?
                   AND COALESCE(origem_tipo, 'EJC') = 'EJC'
                   AND ecc_id = ?
                 ORDER BY nome_tio ASC, nome_tia ASC`,
                [tenantId, eccId]
            );
        }
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar tios para presença:', err);
        return res.status(500).json({ error: 'Erro ao listar tios.' });
    }
});

// GET /api/formularios/public/:token/jovens/:jovemId
router.get('/:token/jovens/:jovemId', async (req, res) => {
    try {
        await garantirEstrutura();
        const token = String(req.params.token || '').trim();
        const jovemId = toPositiveInt(req.params.jovemId);
        if (!token || !jovemId) return res.status(400).json({ error: 'Dados inválidos.' });

        const [forms] = await pool.query(
            `SELECT id, ativo, tenant_id, link_inicio_hora, link_fim_hora
             FROM formularios_itens
             WHERE token = ?
             LIMIT 1`,
            [token]
        );
        if (!forms.length || !forms[0].ativo) return res.status(404).json({ error: 'Formulário não encontrado.' });
        const tenantId = Number(forms[0].tenant_id || 0);
        if (!tenantId) return res.status(400).json({ error: 'Tenant inválido no formulário.' });
        if (!isLinkDisponivel(forms[0])) {
            return res.status(403).json({ error: 'Este link está fora do período de disponibilidade.' });
        }

        const [rows] = await pool.query(
            `SELECT
                j.id,
                j.nome_completo,
                COALESCE(
                    NULLIF(TRIM(COALESCE(j.telefone, '')), ''),
                    (
                        SELECT NULLIF(TRIM(COALESCE(fp.telefone, '')), '')
                        FROM formularios_presencas fp
                        WHERE fp.tenant_id = j.tenant_id
                          AND fp.jovem_id = j.id
                        ORDER BY fp.id DESC
                        LIMIT 1
                    ),
                    (
                        SELECT NULLIF(TRIM(COALESCE(fp.telefone, '')), '')
                        FROM formularios_presencas fp
                        WHERE fp.tenant_id = j.tenant_id
                          AND LOWER(TRIM(COALESCE(fp.nome_completo, ''))) = LOWER(TRIM(COALESCE(j.nome_completo, '')))
                        ORDER BY fp.id DESC
                        LIMIT 1
                    ),
                    ''
                ) AS telefone
             FROM jovens j
             WHERE j.id = ?
               AND j.tenant_id = ?
             LIMIT 1`,
            [jovemId, tenantId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Jovem não encontrado.' });
        return res.json(rows[0]);
    } catch (err) {
        console.error('Erro ao buscar detalhes do jovem na presença pública:', err);
        return res.status(500).json({ error: 'Erro ao buscar jovem.' });
    }
});

router.get('/:token', async (req, res) => {
    try {
        try {
            await garantirEstrutura();
        } catch (estruturaErr) {
            console.error('Aviso: erro ao garantir estrutura no carregamento público. Seguindo com leitura mínima.', estruturaErr);
        }
        const token = String(req.params.token || '').trim();
        if (!token) return res.status(400).json({ error: 'Token inválido.' });

        const [forms] = await pool.query(
            `SELECT *
             FROM formularios_itens
             WHERE token = ?
             LIMIT 1`,
            [token]
        );
        if (!forms.length || !forms[0].ativo) return res.status(404).json({ error: 'Formulário não encontrado.' });
        const rawForm = forms[0] || {};
        const form = {
            ...rawForm,
            criar_lista_presenca: rawForm.criar_lista_presenca === undefined ? 1 : rawForm.criar_lista_presenca,
            usar_lista_jovens: rawForm.usar_lista_jovens === undefined ? 1 : rawForm.usar_lista_jovens,
            coletar_dados_avulsos: rawForm.coletar_dados_avulsos === undefined ? 0 : rawForm.coletar_dados_avulsos,
            pergunta_texto_obrigatoria: rawForm.pergunta_texto_obrigatoria || null,
            permitir_ja_fez_ejc: rawForm.permitir_ja_fez_ejc === undefined ? 1 : rawForm.permitir_ja_fez_ejc,
            permitir_nao_fez_ejc: rawForm.permitir_nao_fez_ejc === undefined ? 1 : rawForm.permitir_nao_fez_ejc,
            permitir_ecc_ecna: rawForm.permitir_ecc_ecna === undefined ? 0 : rawForm.permitir_ecc_ecna,
            permitir_visitante: rawForm.permitir_visitante === undefined ? 1 : rawForm.permitir_visitante,
            campos_config_json: rawForm.campos_config_json || null,
            visual_config_json: rawForm.visual_config_json || null,
            link_inicio_hora: rawForm.link_inicio_hora || null,
            link_fim_hora: rawForm.link_fim_hora || null
        };
        if (!isLinkDisponivel(form)) {
            return res.status(403).json({ error: 'Este link está fora do período de disponibilidade.' });
        }
        if (String(form.tipo || '').toUpperCase() !== 'INSCRICAO' && Number(form.criar_lista_presenca) !== 1) {
            return res.status(400).json({ error: 'Este evento não possui lista de presença ativa.' });
        }

        const camposConfig = sanitizeCamposConfig(form.campos_config_json);

        let jovens = [];
        if (String(form.tipo || '').toUpperCase() !== 'INSCRICAO' && Number(form.permitir_ja_fez_ejc) === 1 && Number(form.usar_lista_jovens) === 1) {
            const [rows] = await pool.query(
                `SELECT
                    j.id,
                    j.nome_completo,
                    COALESCE(
                        NULLIF(TRIM(COALESCE(j.telefone, '')), ''),
                        (
                            SELECT NULLIF(TRIM(COALESCE(fp.telefone, '')), '')
                            FROM formularios_presencas fp
                            WHERE fp.tenant_id = j.tenant_id
                              AND fp.jovem_id = j.id
                            ORDER BY fp.id DESC
                            LIMIT 1
                        ),
                        (
                            SELECT NULLIF(TRIM(COALESCE(fp.telefone, '')), '')
                            FROM formularios_presencas fp
                            WHERE fp.tenant_id = j.tenant_id
                              AND LOWER(TRIM(COALESCE(fp.nome_completo, ''))) = LOWER(TRIM(COALESCE(j.nome_completo, '')))
                            ORDER BY fp.id DESC
                            LIMIT 1
                        ),
                        ''
                    ) AS telefone
                 FROM jovens j
                 WHERE j.tenant_id = ?
                 ORDER BY j.nome_completo ASC`,
                [form.tenant_id]
            );
            jovens = rows;
        }
        let outrosEjcs = [];
        if (String(form.tipo || '').toUpperCase() !== 'INSCRICAO' && Number(form.permitir_ja_fez_ejc) === 1) {
            const hasOutrosEjcs = await hasTable('outros_ejcs');
            if (hasOutrosEjcs) {
                const [rows] = await pool.query(
                    'SELECT id, nome, paroquia, bairro FROM outros_ejcs WHERE tenant_id = ? ORDER BY nome ASC',
                    [form.tenant_id]
                );
                outrosEjcs = rows;
            }
        }
        let encontros = [];
        if (String(form.tipo || '').toUpperCase() !== 'INSCRICAO' && Number(form.permitir_ecc_ecna) === 1) {
            const hasEcc = await hasTable('tios_ecc');
            if (hasEcc) {
                const [rows] = await pool.query(
                    'SELECT id, numero, tipo, descricao FROM tios_ecc WHERE tenant_id = ? ORDER BY numero ASC',
                    [form.tenant_id]
                );
                encontros = rows;
            }
        }
        const meuEjcNome = await getMeuEjcNome(Number(form.tenant_id || 0));

        return res.json({
            formulario: {
                ...form,
                campos_config: camposConfig,
                visual_config: sanitizeVisualConfig(form.visual_config_json)
            },
            jovens,
            outros_ejcs: outrosEjcs,
            encontros,
            meu_ejc_nome: meuEjcNome
        });
    } catch (err) {
        console.error('Erro ao carregar formulário público:', err);
        return res.status(500).json({
            error: 'Erro ao carregar formulário.',
            code: err && err.code ? err.code : null
        });
    }
});

// Upload de imagem para formulário público
router.post('/:token/upload', (req, res) => {
    upload.single('arquivo')(req, res, async (uploadErr) => {
        try {
            await garantirEstrutura();
            const token = String(req.params.token || '').trim();
            if (!token) return res.status(400).json({ error: 'Token inválido.' });

            if (uploadErr) {
                return res.status(400).json({ error: uploadErr.message || 'Erro no upload.' });
            }
            if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

            const [forms] = await pool.query(
                `SELECT id, ativo, tipo, tenant_id, link_inicio_hora, link_fim_hora
                 FROM formularios_itens
                 WHERE token = ?
                 LIMIT 1`,
                [token]
            );
            if (!forms.length || !forms[0].ativo) return res.status(404).json({ error: 'Formulário não encontrado.' });
            if (!isLinkDisponivel(forms[0])) {
                return res.status(403).json({ error: 'Este link está fora do período de disponibilidade.' });
            }
            if (String(forms[0].tipo || '').toUpperCase() !== 'INSCRICAO') {
                return res.status(400).json({ error: 'Upload disponível apenas para inscrição personalizada.' });
            }

            const url = `/uploads/formularios/${req.file.filename}`;
            return res.json({ url, nome: req.file.originalname });
        } catch (err) {
            console.error('Erro no upload do formulário:', err);
            return res.status(500).json({ error: 'Erro ao fazer upload.' });
        }
    });
});

router.post('/:token/respostas', async (req, res) => {
    try {
        await garantirEstrutura();
        const token = String(req.params.token || '').trim();
        const email = String(req.body.email || '').trim();
        const aceiteTermos = req.body.aceite_termos === true || req.body.aceite_termos === 'true' || req.body.aceite_termos === 1 || req.body.aceite_termos === '1';
        if (!token) return res.status(400).json({ error: 'Token inválido.' });

        const [forms] = await pool.query(
            `SELECT id, ativo, tipo, tenant_id, link_inicio_hora, link_fim_hora, campos_config_json
             FROM formularios_itens
             WHERE token = ?
             LIMIT 1`,
            [token]
        );
        if (!forms.length || !forms[0].ativo) return res.status(404).json({ error: 'Formulário não encontrado.' });
        const form = forms[0];
        if (String(form.tipo || '').toUpperCase() !== 'INSCRICAO') {
            return res.status(400).json({ error: 'Este link não é de um formulário de inscrição.' });
        }
        if (!isLinkDisponivel(form)) {
            return res.status(403).json({ error: 'Este link está fora do período de disponibilidade.' });
        }
        const tenantId = Number(form.tenant_id || 0);
        if (!tenantId) return res.status(400).json({ error: 'Tenant inválido no formulário.' });

        const camposConfig = sanitizeCamposConfig(form.campos_config_json);
        if (!camposConfig.length) {
            return res.status(400).json({ error: 'Formulário sem campos configurados.' });
        }
        const emailRegex = /^\S+@\S+\.\S+$/;
        if (!email || !emailRegex.test(email)) {
            return res.status(400).json({ error: 'Informe um e-mail válido.' });
        }
        if (!aceiteTermos) {
            return res.status(400).json({ error: 'É necessário aceitar os termos de uso.' });
        }

        const respostasNormalizadas = normalizeFormResponses(camposConfig, req.body.respostas);
        if (respostasNormalizadas.error) {
            return res.status(400).json({ error: respostasNormalizadas.error });
        }
        const respostaFinal = respostasNormalizadas.respostaFinal;

        let nomeReferencia = null;
        let telefoneReferencia = null;
        for (const campo of camposConfig) {
            const valor = respostaFinal[campo.id];
            const label = String(campo.label || '').toLowerCase();
            if (!nomeReferencia && typeof valor === 'string' && valor && (label.includes('nome') || campo.id.includes('nome'))) {
                nomeReferencia = valor.slice(0, 180);
            }
            if (!telefoneReferencia && typeof valor === 'string' && valor && (label.includes('telefone') || campo.id.includes('telefone') || campo.tipo === 'telefone')) {
                telefoneReferencia = valor.slice(0, 30);
            }
        }

        const payload = respostasNormalizadas.payload;

        const ipRaw = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
        const ip = String(Array.isArray(ipRaw) ? ipRaw[0] : ipRaw).slice(0, 64) || null;
        const userAgent = String(req.headers['user-agent'] || '').slice(0, 255) || null;

        await pool.query(
            `INSERT INTO formularios_respostas
                (tenant_id, formulario_id, nome_referencia, telefone_referencia, email, termos_aceitos_em, resposta_json, ip, user_agent)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                tenantId,
                form.id,
                nomeReferencia,
                telefoneReferencia,
                email,
                new Date(),
                JSON.stringify(payload),
                ip,
                userAgent
            ]
        );

        // Marca os termos no cadastro do jovem da Lista Mestre (quando houver correspondência)
        try {
            await ensureJovensTermosColumns();
            let jovemIdAlvo = null;

            const [byEmail] = await pool.query(
                `SELECT id
                 FROM jovens
                 WHERE tenant_id = ?
                   AND LOWER(TRIM(COALESCE(email, ''))) = LOWER(TRIM(?))
                 ORDER BY id DESC
                 LIMIT 1`,
                [tenantId, email]
            );
            if (byEmail && byEmail.length) {
                jovemIdAlvo = Number(byEmail[0].id);
            }

            if (!jovemIdAlvo && nomeReferencia && telefoneReferencia) {
                const telefoneDigits = normalizePhoneDigits(telefoneReferencia);
                if (telefoneDigits) {
                    const [byNomeTelefone] = await pool.query(
                        `SELECT id
                         FROM jovens
                         WHERE tenant_id = ?
                           AND LOWER(TRIM(COALESCE(nome_completo, ''))) = LOWER(TRIM(?))
                           AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(COALESCE(telefone, '')), ' ', ''), '(', ''), ')', ''), '-', ''), '+', '') = ?
                         ORDER BY id DESC
                         LIMIT 1`,
                        [tenantId, nomeReferencia, telefoneDigits]
                    );
                    if (byNomeTelefone && byNomeTelefone.length) {
                        jovemIdAlvo = Number(byNomeTelefone[0].id);
                    }
                }
            }

            if (jovemIdAlvo) {
                await pool.query(
                    `UPDATE jovens
                     SET termos_aceitos_em = CURRENT_TIMESTAMP,
                         termos_aceitos_email = ?,
                         email = COALESCE(NULLIF(?, ''), email)
                     WHERE id = ? AND tenant_id = ?`,
                    [email, email, jovemIdAlvo, tenantId]
                );
            }
        } catch (syncErr) {
            console.error('Erro ao sincronizar termos no cadastro de jovens:', syncErr);
        }

        return res.json({ message: 'Inscrição enviada com sucesso.' });
    } catch (err) {
        console.error('Erro ao registrar inscrição:', err);
        return res.status(500).json({ error: 'Erro ao enviar inscrição.' });
    }
});

router.post('/:token/presencas', async (req, res) => {
    try {
        await garantirEstrutura();
        const token = String(req.params.token || '').trim();
        const emailRaw = String(req.body.email || '').trim();
        const email = emailRaw || null;
        const jovemId = toPositiveInt(req.body.jovem_id);
        const nomeCompleto = String(req.body.nome_completo || '').trim();
        const telefone = String(req.body.telefone || '').trim();
        const ejcOrigem = String(req.body.ejc_origem || '').trim();
        const statusEjc = String(req.body.status_ejc || '').trim().toUpperCase();
        const origemJaFez = String(req.body.origem_ja_fez || '').trim().toUpperCase();
        const outroEjcId = toPositiveInt(req.body.outro_ejc_id);
        const modoOutroEjc = String(req.body.primeira_vez_outro_ejc || '').trim().toUpperCase();
        const participanteHistoricoId = toPositiveInt(req.body.participante_historico_id);
        const participanteReferencia = String(req.body.participante_referencia || '').trim();
        const respostaTextoObrigatoria = String(req.body.resposta_texto_obrigatoria || '').trim();
        const dataNascimento = normalizeDate(req.body.data_nascimento);
        const sexo = String(req.body.sexo || '').trim();
        const estadoCivil = String(req.body.estado_civil || '').trim();
        const instagram = String(req.body.instagram || '').trim();
        const tipoParticipanteRaw = String(req.body.tipo_participante || '').trim().toUpperCase();
        const eccTipoRaw = String(req.body.ecc_tipo || '').trim().toUpperCase();
        const eccId = toPositiveInt(req.body.ecc_id);
        const tioCasalId = toPositiveInt(req.body.tio_casal_id);
        const origemTio = String(req.body.origem_tio || 'EJC').trim().toUpperCase() === 'OUTRO_EJC' ? 'OUTRO_EJC' : 'EJC';
        if (!token) return res.status(400).json({ error: 'Dados inválidos.' });
        const emailRegex = /^\S+@\S+\.\S+$/;
        if (email && !emailRegex.test(email)) {
            return res.status(400).json({ error: 'Informe um e-mail válido.' });
        }

        const [forms] = await pool.query(
            `SELECT id, ativo, tipo, criar_lista_presenca, usar_lista_jovens, coletar_dados_avulsos, permitir_ja_fez_ejc,
                    permitir_nao_fez_ejc, permitir_ecc_ecna, permitir_visitante,
                    tenant_id, pergunta_texto_obrigatoria, link_inicio_hora, link_fim_hora, campos_config_json
             FROM formularios_itens
             WHERE token = ?
             LIMIT 1`,
            [token]
        );
        if (!forms.length || !forms[0].ativo) return res.status(404).json({ error: 'Formulário não encontrado.' });
        const form = forms[0];
        if (String(form.tipo || '').toUpperCase() === 'INSCRICAO') {
            return res.status(400).json({ error: 'Este link usa formulário de inscrição personalizada.' });
        }
        const tenantId = Number(form.tenant_id || 0);
        if (!tenantId) return res.status(400).json({ error: 'Tenant inválido no formulário.' });
        const meuEjcNome = await getMeuEjcNome(tenantId);
        if (!isLinkDisponivel(form)) {
            return res.status(403).json({ error: 'Este link está fora do período de disponibilidade.' });
        }
        if (Number(form.criar_lista_presenca) !== 1) {
            return res.status(400).json({ error: 'Este evento não possui lista de presença ativa.' });
        }
        if (String(form.pergunta_texto_obrigatoria || '').trim() && !respostaTextoObrigatoria) {
            return res.status(400).json({ error: 'Responda a pergunta obrigatória do formulário.' });
        }
        const camposConfig = sanitizeCamposConfig(form.campos_config_json);
        const respostasNormalizadas = normalizeFormResponses(camposConfig, req.body.respostas);
        if (respostasNormalizadas.error) {
            return res.status(400).json({ error: respostasNormalizadas.error });
        }
        const respostaJson = camposConfig.length ? JSON.stringify(respostasNormalizadas.payload) : null;

        const permiteJaFez = Number(form.permitir_ja_fez_ejc) === 1;
        const permiteNaoFez = Number(form.permitir_nao_fez_ejc) === 1;
        const permiteEcc = Number(form.permitir_ecc_ecna) === 1;
        const permiteVisitante = Number(form.permitir_visitante) === 1;
        const permiteListaJovens = Number(form.usar_lista_jovens) === 1;

        if (!permiteJaFez && !permiteNaoFez && !permiteEcc && !permiteVisitante) {
            return res.status(400).json({ error: 'Formulário sem configuração de opções.' });
        }

        const tipoParticipante = tipoParticipanteRaw;
        if (['FEZ_ECC', 'FEZ_ECNA', 'TIO_OUTRO_EJC'].includes(tipoParticipante)) {
            if (!permiteEcc) {
                return res.status(400).json({ error: 'Este formulário não aceita a opção ECC/ECNA.' });
            }
            const hasTiosCasais = await hasTable('tios_casais');
            if (!hasTiosCasais) {
                return res.status(400).json({ error: 'Cadastro de tios indisponível.' });
            }
            let eccTipo = null;
            let casalRows = [];
            let outroEjcIdRegistro = null;
            if (tipoParticipante === 'TIO_OUTRO_EJC') {
                if (origemTio !== 'OUTRO_EJC' || !outroEjcId || !tioCasalId) {
                    return res.status(400).json({ error: 'Selecione a paróquia e o casal de tios.' });
                }
                outroEjcIdRegistro = outroEjcId;
                [casalRows] = await pool.query(
                    `SELECT id
                     FROM tios_casais
                     WHERE id = ? AND tenant_id = ?
                       AND COALESCE(origem_tipo, 'EJC') = 'OUTRO_EJC'
                       AND outro_ejc_id = ?
                     LIMIT 1`,
                    [tioCasalId, tenantId, outroEjcId]
                );
            } else {
                const hasTiosEcc = await hasTable('tios_ecc');
                if (!hasTiosEcc) {
                    return res.status(400).json({ error: 'Cadastro de encontros de tios indisponível.' });
                }
                eccTipo = (eccTipoRaw === 'ECNA' ? 'ECNA' : (eccTipoRaw === 'ECC' ? 'ECC' : null)) || (tipoParticipante === 'FEZ_ECNA' ? 'ECNA' : 'ECC');
                if (!eccId || !tioCasalId) {
                    return res.status(400).json({ error: 'Selecione o encontro e o casal de tios.' });
                }
                const [eccRows] = await pool.query(
                    'SELECT id, tipo FROM tios_ecc WHERE id = ? AND tenant_id = ? LIMIT 1',
                    [eccId, tenantId]
                );
                if (!eccRows.length) return res.status(400).json({ error: 'Encontro não encontrado.' });
                const tipoEncontrado = String(eccRows[0].tipo || 'ECC').toUpperCase() === 'ECNA' ? 'ECNA' : 'ECC';
                if (tipoEncontrado !== eccTipo) {
                    return res.status(400).json({ error: 'Encontro incompatível com o tipo selecionado.' });
                }
                [casalRows] = await pool.query(
                    `SELECT id
                     FROM tios_casais
                     WHERE id = ? AND tenant_id = ?
                       AND COALESCE(origem_tipo, 'EJC') = 'EJC'
                       AND ecc_id = ?
                     LIMIT 1`,
                    [tioCasalId, tenantId, eccId]
                );
            }
            if (!casalRows.length) return res.status(400).json({ error: 'Casal de tios não encontrado.' });

            const ipRaw = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
            const ip = String(Array.isArray(ipRaw) ? ipRaw[0] : ipRaw).slice(0, 64) || null;
            const userAgent = String(req.headers['user-agent'] || '').slice(0, 255) || null;

            await pool.query(
                `INSERT INTO formularios_presencas
                    (tenant_id, formulario_id, jovem_id, nome_completo, telefone, email, termos_aceitos_em, ejc_origem, status_ejc, origem_ja_fez,
                     outro_ejc_id, tipo_participante, ecc_tipo, ecc_id, tio_casal_id, resposta_texto_obrigatoria, resposta_json, ip, user_agent)
                 VALUES (?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    tenantId,
                    form.id,
                    email,
                    null,
                    outroEjcIdRegistro,
                    tipoParticipante,
                    eccTipo,
                    tipoParticipante === 'TIO_OUTRO_EJC' ? null : eccId,
                    tioCasalId,
                    String(form.pergunta_texto_obrigatoria || '').trim() ? respostaTextoObrigatoria : null,
                    respostaJson,
                    ip,
                    userAgent
                ]
            );
            return res.json({ message: 'Presença registrada com sucesso.' });
        }

        if (!['JA_FIZ', 'NAO_FIZ'].includes(statusEjc)) {
            return res.status(400).json({ error: 'Selecione se já fez EJC ou se é visitante.' });
        }
        if (statusEjc === 'JA_FIZ' && !permiteJaFez) {
            return res.status(400).json({ error: 'Este formulário não aceita a opção "fiz EJC".' });
        }
        if (statusEjc === 'NAO_FIZ' && !permiteVisitante && !permiteNaoFez) {
            return res.status(400).json({ error: 'Este formulário não aceita a opção visitante.' });
        }

        let jovemIdFinal = null;
        let nomeFinal = null;
        let telefoneFinal = null;
        let ejcOrigemFinal = null;
        let origemJaFezFinal = null;
        let outroEjcIdFinal = null;

        if (statusEjc === 'JA_FIZ') {
            if (!['INCONFIDENTES', 'OUTRO_EJC'].includes(origemJaFez)) {
                return res.status(400).json({ error: 'Selecione se fez EJC Inconfidentes ou outro EJC.' });
            }
            origemJaFezFinal = origemJaFez;

            if (origemJaFez === 'INCONFIDENTES') {
                if (!permiteListaJovens) {
                    return res.status(400).json({ error: 'Este formulário não aceita seleção da lista de jovens.' });
                }
                if (!jovemId) return res.status(400).json({ error: 'Selecione seu nome na lista de jovens.' });
                const [jovemExists] = await pool.query(
                    'SELECT id, nome_completo, telefone FROM jovens WHERE id = ? AND tenant_id = ? LIMIT 1',
                    [jovemId, tenantId]
                );
                if (!jovemExists.length) return res.status(400).json({ error: 'Jovem inválido.' });
                jovemIdFinal = jovemId;
                nomeFinal = jovemExists[0].nome_completo || null;
                telefoneFinal = jovemExists[0].telefone || null;
                ejcOrigemFinal = meuEjcNome || 'Inconfidentes';
            } else {
                if (!['PRIMEIRA_VEZ', 'JA_PARTICIPOU'].includes(modoOutroEjc)) {
                    return res.status(400).json({ error: 'Selecione se é o primeiro evento ou se já participou de outros eventos.' });
                }
                if (modoOutroEjc === 'PRIMEIRA_VEZ') {
                    if (!nomeCompleto || !telefone || !outroEjcId) {
                        return res.status(400).json({ error: 'Informe nome completo, telefone e o outro EJC.' });
                    }
                    const hasOutrosEjcs = await hasTable('outros_ejcs');
                    if (!hasOutrosEjcs) {
                        return res.status(400).json({ error: 'Cadastro de outros EJCs não está disponível no momento.' });
                    }
                    const [outroEjcExists] = await pool.query(
                        'SELECT id, nome, paroquia FROM outros_ejcs WHERE id = ? AND tenant_id = ? LIMIT 1',
                        [outroEjcId, tenantId]
                    );
                    if (!outroEjcExists.length) return res.status(400).json({ error: 'Outro EJC inválido.' });
                    const sexoNormalizado = (sexo === 'Feminino' || sexo === 'Masculino') ? sexo : null;
                    const estadoCivilNormalizado = ['Solteiro', 'Casado', 'Amasiado'].includes(estadoCivil) ? estadoCivil : 'Solteiro';
                    const instagramNormalizado = instagram || null;
                    const telefoneDigits = normalizePhoneDigits(telefone);

                    const [jovensExistentes] = await pool.query(
                        `SELECT id
                         FROM jovens
                         WHERE tenant_id = ?
                           AND COALESCE(origem_ejc_tipo, 'INCONFIDENTES') = 'OUTRO_EJC'
                           AND outro_ejc_id = ?
                           AND LOWER(TRIM(nome_completo)) = LOWER(TRIM(?))
                           AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(COALESCE(telefone, '')), ' ', ''), '(', ''), ')', ''), '-', ''), '+', '') = ?
                         LIMIT 1`,
                        [tenantId, outroEjcId, nomeCompleto, telefoneDigits]
                    );

                    if (jovensExistentes.length) {
                        jovemIdFinal = Number(jovensExistentes[0].id);
                        const camposUpdate = ['nome_completo = ?', 'telefone = ?', 'outro_ejc_id = ?', "origem_ejc_tipo = 'OUTRO_EJC'"];
                        const paramsUpdate = [nomeCompleto, telefone, outroEjcId];
                        if (await hasColumn('jovens', 'data_nascimento')) {
                            camposUpdate.push('data_nascimento = COALESCE(?, data_nascimento)');
                            paramsUpdate.push(dataNascimento);
                        }
                        if (await hasColumn('jovens', 'sexo')) {
                            camposUpdate.push('sexo = COALESCE(?, sexo)');
                            paramsUpdate.push(sexoNormalizado);
                        }
                        if (await hasColumn('jovens', 'estado_civil')) {
                            camposUpdate.push('estado_civil = COALESCE(?, estado_civil)');
                            paramsUpdate.push(estadoCivilNormalizado);
                        }
                        if (await hasColumn('jovens', 'instagram')) {
                            camposUpdate.push('instagram = COALESCE(?, instagram)');
                            paramsUpdate.push(instagramNormalizado);
                        }
                        if (await hasColumn('jovens', 'transferencia_outro_ejc')) {
                            camposUpdate.push('transferencia_outro_ejc = 0');
                        }
                        paramsUpdate.push(jovemIdFinal, tenantId);
                        await pool.query(
                            `UPDATE jovens SET ${camposUpdate.join(', ')} WHERE id = ? AND tenant_id = ?`,
                            paramsUpdate
                        );
                    } else {
                        const camposInsert = ['tenant_id', 'nome_completo', 'telefone', 'origem_ejc_tipo', 'outro_ejc_id'];
                        const valoresInsert = [tenantId, nomeCompleto, telefone, 'OUTRO_EJC', outroEjcId];
                        if (await hasColumn('jovens', 'data_nascimento')) {
                            camposInsert.push('data_nascimento');
                            valoresInsert.push(dataNascimento);
                        }
                        if (await hasColumn('jovens', 'sexo')) {
                            camposInsert.push('sexo');
                            valoresInsert.push(sexoNormalizado);
                        }
                        if (await hasColumn('jovens', 'estado_civil')) {
                            camposInsert.push('estado_civil');
                            valoresInsert.push(estadoCivilNormalizado);
                        }
                        if (await hasColumn('jovens', 'instagram')) {
                            camposInsert.push('instagram');
                            valoresInsert.push(instagramNormalizado);
                        }
                        if (await hasColumn('jovens', 'transferencia_outro_ejc')) {
                            camposInsert.push('transferencia_outro_ejc');
                            valoresInsert.push(0);
                        }
                        const placeholdersInsert = camposInsert.map(() => '?').join(', ');
                        const [jovemIns] = await pool.query(
                            `INSERT INTO jovens (${camposInsert.join(', ')}) VALUES (${placeholdersInsert})`,
                            valoresInsert
                        );
                        jovemIdFinal = Number(jovemIns.insertId);
                    }
                    nomeFinal = nomeCompleto;
                    telefoneFinal = telefone;
                    outroEjcIdFinal = outroEjcId;
                    ejcOrigemFinal = [outroEjcExists[0].paroquia, outroEjcExists[0].nome].filter(Boolean).join(' - ') || 'Outro EJC';
                } else {
                    const usarReferencia = /^([HJ]):(\d+)$/.exec(participanteReferencia);
                    const tipoRef = usarReferencia ? usarReferencia[1] : null;
                    const idRef = usarReferencia ? Number(usarReferencia[2]) : null;
                    if (!idRef && !participanteHistoricoId) {
                        return res.status(400).json({ error: 'Selecione seu nome na lista de jovens de outro EJC.' });
                    }
                    if (tipoRef === 'J') {
                        const [jovensRows] = await pool.query(`
                            SELECT id, nome_completo, telefone, outro_ejc_id
                            FROM jovens
                            WHERE id = ?
                              AND tenant_id = ?
                              AND COALESCE(origem_ejc_tipo, 'INCONFIDENTES') = 'OUTRO_EJC'
                            LIMIT 1
                        `, [idRef, tenantId]);
                        if (!jovensRows.length) {
                            return res.status(400).json({ error: 'Cadastro do jovem de outro EJC não encontrado.' });
                        }
                        const jovem = jovensRows[0];
                        if (!jovem.outro_ejc_id) {
                            return res.status(400).json({ error: 'Cadastro sem EJC de origem vinculado.' });
                        }
                        const hasOutrosEjcs = await hasTable('outros_ejcs');
                        if (!hasOutrosEjcs) {
                            return res.status(400).json({ error: 'Cadastro de outros EJCs não está disponível no momento.' });
                        }
                        const [outroEjcExists] = await pool.query(
                            'SELECT id, nome, paroquia FROM outros_ejcs WHERE id = ? AND tenant_id = ? LIMIT 1',
                            [jovem.outro_ejc_id, tenantId]
                        );
                        if (!outroEjcExists.length) return res.status(400).json({ error: 'Outro EJC vinculado não encontrado.' });

                        nomeFinal = String(jovem.nome_completo || '').trim() || null;
                        telefoneFinal = String(jovem.telefone || '').trim() || null;
                        jovemIdFinal = jovem.id;
                        outroEjcIdFinal = jovem.outro_ejc_id;
                        ejcOrigemFinal = [outroEjcExists[0].paroquia, outroEjcExists[0].nome].filter(Boolean).join(' - ') || 'Outro EJC';
                    } else {
                        const idBuscaHistorico = idRef || participanteHistoricoId;
                        const [historicoRows] = await pool.query(`
                            SELECT id, nome_completo, telefone, outro_ejc_id
                            FROM formularios_presencas
                            WHERE id = ?
                              AND tenant_id = ?
                              AND status_ejc = 'JA_FIZ'
                              AND origem_ja_fez = 'OUTRO_EJC'
                            LIMIT 1
                        `, [idBuscaHistorico, tenantId]);
                        if (!historicoRows.length) {
                            return res.status(400).json({ error: 'Registro do jovem não encontrado.' });
                        }
                        const historico = historicoRows[0];
                        if (!historico.outro_ejc_id) {
                            return res.status(400).json({ error: 'Registro antigo sem EJC vinculado. Use "primeiro evento".' });
                        }
                        const hasOutrosEjcs = await hasTable('outros_ejcs');
                        if (!hasOutrosEjcs) {
                            return res.status(400).json({ error: 'Cadastro de outros EJCs não está disponível no momento.' });
                        }
                        const [outroEjcExists] = await pool.query(
                            'SELECT id, nome, paroquia FROM outros_ejcs WHERE id = ? AND tenant_id = ? LIMIT 1',
                            [historico.outro_ejc_id, tenantId]
                        );
                        if (!outroEjcExists.length) return res.status(400).json({ error: 'Outro EJC vinculado não encontrado.' });

                        nomeFinal = String(historico.nome_completo || '').trim() || null;
                        telefoneFinal = String(historico.telefone || '').trim() || null;
                        outroEjcIdFinal = historico.outro_ejc_id;
                        ejcOrigemFinal = [outroEjcExists[0].paroquia, outroEjcExists[0].nome].filter(Boolean).join(' - ') || 'Outro EJC';
                    }

                    if (!nomeFinal || !telefoneFinal || !outroEjcIdFinal) {
                        return res.status(400).json({ error: 'Registro incompleto. Use "primeiro evento".' });
                    }
                }
            }
        } else {
            if (!nomeCompleto || !telefone) {
                return res.status(400).json({ error: 'Informe nome completo e telefone.' });
            }
            nomeFinal = nomeCompleto;
            telefoneFinal = telefone;
            ejcOrigemFinal = 'Não fez EJC';
        }

        const ipRaw = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
        const ip = String(Array.isArray(ipRaw) ? ipRaw[0] : ipRaw).slice(0, 64) || null;
        const userAgent = String(req.headers['user-agent'] || '').slice(0, 255) || null;

        try {
            await pool.query(
                `INSERT INTO formularios_presencas
                    (tenant_id, formulario_id, jovem_id, nome_completo, telefone, email, termos_aceitos_em, ejc_origem, status_ejc, origem_ja_fez, outro_ejc_id,
                     tipo_participante, ecc_tipo, ecc_id, tio_casal_id, resposta_texto_obrigatoria, resposta_json, ip, user_agent)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)`,
                [
                    tenantId,
                    form.id,
                    jovemIdFinal,
                    nomeFinal,
                    telefoneFinal,
                    email,
                    null,
                    ejcOrigemFinal || ejcOrigem || null,
                    statusEjc,
                    origemJaFezFinal,
                    outroEjcIdFinal,
                    statusEjc === 'JA_FIZ'
                        ? (origemJaFezFinal === 'OUTRO_EJC' ? 'FEZ_OUTRO_EJC' : 'FEZ_EJC')
                        : 'NAO_FIZ',
                    String(form.pergunta_texto_obrigatoria || '').trim() ? respostaTextoObrigatoria : null,
                    respostaJson,
                    ip,
                    userAgent
                ]
            );
        } catch (errIns) {
            if (errIns && errIns.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ error: 'Presença já registrada para este jovem.' });
            }
            throw errIns;
        }

        return res.json({ message: 'Presença registrada com sucesso.' });
    } catch (err) {
        console.error('Erro ao registrar presença:', err);
        return res.status(500).json({ error: 'Erro ao registrar presença.' });
    }
});

module.exports = router;
