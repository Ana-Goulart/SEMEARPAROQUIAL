const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pool } = require('../database');
const { ensurePastoraisTables } = require('../lib/pastorais');
const { decryptJovemEmail, decryptJovemPhone, encryptJovemEmail, encryptJovemPhone, jovemEmailHash, jovemPhoneHash } = require('../lib/jovensSensitiveData');
const { decryptTioCpf, decryptTioPhone, encryptTioCpf, encryptTioPhone, encryptTioSensitiveText, tioCpfHash, tioPhoneHash } = require('../lib/tiosSensitiveData');
const { blindIndex, decryptValue, encryptValue } = require('../lib/fieldEncryption');
const { normalizeUpperText } = require('../lib/personNameFormatting');

const router = express.Router();

const uploadDirAbs = path.join(__dirname, '..', 'public', 'uploads', 'fotos_jovens');
const upload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => {
            fs.mkdirSync(uploadDirAbs, { recursive: true });
            cb(null, uploadDirAbs);
        },
        filename: (_req, file, cb) => {
            const ext = path.extname(String(file.originalname || '')).toLowerCase();
            cb(null, `atualizacao-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
        if (!allowed.has(String(file.mimetype || '').toLowerCase())) {
            const err = new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname);
            err.message = 'Envie apenas imagens JPG, PNG ou WEBP.';
            return cb(err);
        }
        return cb(null, true);
    }
});

function boolValue(value) {
    return value === true || value === 1 || value === '1' || value === 'true' || value === 'Sim';
}

function parseJsonArray(value) {
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(String(value || '[]'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

function normalizeDate(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const br = text.match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})$/);
    if (!br) return null;
    return `${br[3]}-${br[2]}-${br[1]}`;
}

function normalizeCpfDigits(value) {
    const digits = String(value || '').replace(/\D/g, '').slice(0, 11);
    return digits.length === 11 ? digits : '';
}

function formatCpf(value) {
    const digits = normalizeCpfDigits(value);
    if (!digits) return '';
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

function encryptCpf(value) {
    const formatted = formatCpf(value);
    return formatted ? encryptValue(formatted, 'lista-mestre:cpf') : null;
}

function cpfHash(value) {
    const digits = normalizeCpfDigits(value);
    return digits ? blindIndex(digits, 'lista-mestre:cpf') : null;
}

function serializeInstrumentos(value, enabled) {
    if (!enabled) return null;
    const items = parseJsonArray(value).map((item) => String(item || '').trim()).filter(Boolean);
    return items.length ? JSON.stringify(items) : null;
}

function parseJsonArraySeguro(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(String(value));
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

function dateToInput(value) {
    if (!value) return '';
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
}

function removerUploadTemporario(file) {
    if (!file || !file.path) return;
    fs.unlink(file.path, () => {});
}

function publicBaseUrl(req) {
    const configured = String(process.env.SEMEAR_JOVENS_PUBLIC_URL || process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
    if (configured) return configured;
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return host ? `${proto}://${host}` : '';
}

function gerarTokenAtualizacao() {
    return crypto.randomBytes(32).toString('base64url');
}

async function obterOuCriarTokenAtualizacao({ tenantId, jovemId, ejcId = null, montagemId = null, equipeId = null }) {
    const [existentes] = await pool.query(
        `SELECT id, token, atualizado, usado_em, invalidado_em
         FROM jovens_atualizacao_tokens
         WHERE tenant_id = ?
           AND jovem_id = ?
           AND (ejc_id <=> ?)
           AND (montagem_id <=> ?)
           AND (equipe_id <=> ?)
         LIMIT 1`,
        [tenantId, jovemId, ejcId, montagemId, equipeId]
    );
    if (existentes.length) return existentes[0];

    const token = gerarTokenAtualizacao();
    const [result] = await pool.query(
        `INSERT INTO jovens_atualizacao_tokens (tenant_id, jovem_id, ejc_id, montagem_id, equipe_id, token)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [tenantId, jovemId, ejcId, montagemId, equipeId, token]
    );
    return { id: result.insertId, token, atualizado: 0 };
}

async function obterOuCriarTokenTiosAtualizacao({ tenantId, casalId, montagemId = null, equipeId = null }) {
    const [existentes] = await pool.query(
        `SELECT id, token, atualizado, usado_em, invalidado_em
         FROM tios_atualizacao_tokens
         WHERE tenant_id = ?
           AND casal_id = ?
           AND (montagem_id <=> ?)
           AND (equipe_id <=> ?)
         LIMIT 1`,
        [tenantId, casalId, montagemId, equipeId]
    );
    if (existentes.length) return existentes[0];

    const token = gerarTokenAtualizacao();
    const [result] = await pool.query(
        `INSERT INTO tios_atualizacao_tokens (tenant_id, casal_id, montagem_id, equipe_id, token)
         VALUES (?, ?, ?, ?, ?)`,
        [tenantId, casalId, montagemId, equipeId, token]
    );
    return { id: result.insertId, token, atualizado: 0 };
}

async function getTiosTokenContext(token) {
    const [rows] = await pool.query(
        `SELECT tok.*, c.origem_tipo, c.outro_ejc_id, c.encontro_tipo,
                c.nome_tio, c.telefone_tio, c.cpf_tio, c.data_nascimento_tio,
                c.nome_tia, c.telefone_tia, c.cpf_tia, c.data_nascimento_tia,
                c.deficiencia_tio, c.qual_deficiencia_tio, c.restricao_alimentar_tio, c.detalhes_restricao_tio, c.possui_carro_tio,
                c.deficiencia_tia, c.qual_deficiencia_tia, c.restricao_alimentar_tia, c.detalhes_restricao_tia, c.possui_carro_tia
         FROM tios_atualizacao_tokens tok
         JOIN tios_casais c ON c.id = tok.casal_id AND c.tenant_id = tok.tenant_id
         WHERE tok.token = ?
         LIMIT 1`,
        [token]
    );
    const ctx = rows && rows[0] ? rows[0] : null;
    if (!ctx || ctx.invalidado_em) return null;
    return ctx;
}

async function carregarContextoEquipe(token) {
    const [rows] = await pool.query(
        `SELECT et.*, eq.nome AS equipe_nome, e.numero AS ejc_numero, m.numero_ejc AS montagem_numero
         FROM equipes_atualizacao_tokens et
         JOIN equipes eq ON eq.id = et.equipe_id AND eq.tenant_id = et.tenant_id
         LEFT JOIN ejc e ON e.id = et.ejc_id AND e.tenant_id = et.tenant_id
         LEFT JOIN montagens m ON m.id = et.montagem_id AND m.tenant_id = et.tenant_id
         WHERE et.token = ?
           AND et.invalidado_em IS NULL
         LIMIT 1`,
        [token]
    );
    return rows && rows[0] ? rows[0] : null;
}

async function listarMembrosEquipe(ctx, req) {
    const tenantId = Number(ctx.tenant_id);
    const equipeId = Number(ctx.equipe_id);
    const ejcId = ctx.tipo === 'montagem' ? null : Number(ctx.ejc_id);
    const montagemId = ctx.tipo === 'montagem' ? Number(ctx.montagem_id) : null;
    let rows = [];

    if (montagemId) {
        [rows] = await pool.query(
            `SELECT DISTINCT j.id AS jovem_id, j.nome_completo, j.telefone, ef.nome AS subfuncao,
                    tok.token, tok.atualizado
             FROM montagem_membros mm
             JOIN jovens j ON j.id = mm.jovem_id AND j.tenant_id = mm.tenant_id
             LEFT JOIN equipes_funcoes ef ON ef.id = mm.funcao_id
             LEFT JOIN jovens_atualizacao_tokens tok
               ON tok.tenant_id = mm.tenant_id
              AND tok.jovem_id = mm.jovem_id
              AND tok.montagem_id = mm.montagem_id
              AND tok.equipe_id = mm.equipe_id
              AND tok.ejc_id IS NULL
             WHERE mm.tenant_id = ?
               AND mm.montagem_id = ?
               AND mm.equipe_id = ?
               AND mm.eh_substituicao = 0
               AND mm.jovem_id IS NOT NULL
             ORDER BY j.nome_completo ASC`,
            [tenantId, montagemId, equipeId]
        );
    } else {
        [rows] = await pool.query(
            `SELECT DISTINCT j.id AS jovem_id, j.nome_completo, j.telefone, he.subfuncao,
                    tok.token, tok.atualizado
             FROM historico_equipes he
             JOIN jovens j ON j.id = he.jovem_id AND j.tenant_id = he.tenant_id
             LEFT JOIN jovens_atualizacao_tokens tok
               ON tok.tenant_id = he.tenant_id
              AND tok.jovem_id = he.jovem_id
              AND tok.ejc_id = he.ejc_id
              AND tok.equipe_id = ?
              AND tok.montagem_id IS NULL
             WHERE he.tenant_id = ?
               AND he.ejc_id = ?
               AND he.equipe = (SELECT nome FROM equipes WHERE id = ? AND tenant_id = ? LIMIT 1)
               AND he.jovem_id IS NOT NULL
             ORDER BY j.nome_completo ASC`,
            [equipeId, tenantId, ejcId, equipeId, tenantId]
        );
    }

    const baseUrl = publicBaseUrl(req);
    const membros = [];
    for (const row of rows || []) {
        // eslint-disable-next-line no-await-in-loop
        const tokenRow = row.token ? row : await obterOuCriarTokenAtualizacao({
            tenantId,
            jovemId: Number(row.jovem_id),
            ejcId,
            montagemId,
            equipeId
        });
        membros.push({
            jovem_id: Number(row.jovem_id),
            nome_completo: row.nome_completo,
            telefone: decryptJovemPhone(row.telefone) || '',
            subfuncao: row.subfuncao || '',
            atualizado: Number(row.atualizado || tokenRow.atualizado || 0) === 1,
            link: `${baseUrl}/atualizar/${encodeURIComponent(tokenRow.token || row.token)}`
        });
    }

    if (montagemId) {
        const [tiosRows] = await pool.query(
            `SELECT DISTINCT tc.id AS casal_id, tc.nome_tio, tc.nome_tia, tc.telefone_tio, tc.telefone_tia, ef.nome AS subfuncao,
                    tok.token, tok.atualizado
             FROM montagem_membros mm
             JOIN tios_casais tc ON tc.id = mm.tio_casal_id AND tc.tenant_id = mm.tenant_id
             LEFT JOIN equipes_funcoes ef ON ef.id = mm.funcao_id
             LEFT JOIN tios_atualizacao_tokens tok
               ON tok.tenant_id = mm.tenant_id
              AND tok.casal_id = tc.id
              AND tok.montagem_id = mm.montagem_id
              AND tok.equipe_id = mm.equipe_id
             WHERE mm.tenant_id = ?
               AND mm.montagem_id = ?
               AND mm.equipe_id = ?
               AND mm.eh_substituicao = 0
               AND mm.jovem_id IS NULL
               AND mm.tio_casal_id IS NOT NULL
             ORDER BY tc.nome_tio ASC, tc.nome_tia ASC`,
            [tenantId, montagemId, equipeId]
        );
        for (const row of tiosRows || []) {
            // eslint-disable-next-line no-await-in-loop
            const tokenRow = row.token ? row : await obterOuCriarTokenTiosAtualizacao({
                tenantId,
                casalId: Number(row.casal_id),
                montagemId,
                equipeId
            });
            membros.push({
                tipo: 'TIO_CASAL',
                casal_id: Number(row.casal_id),
                jovem_id: null,
                nome_completo: [row.nome_tio, row.nome_tia].filter(Boolean).join(' e '),
                telefone: [decryptTioPhone(row.telefone_tio), decryptTioPhone(row.telefone_tia)].filter(Boolean).join(' / '),
                subfuncao: row.subfuncao || 'Tios',
                atualizado: Number(row.atualizado || tokenRow.atualizado || 0) === 1,
                link: `${baseUrl}/atualizar-tios/${encodeURIComponent(tokenRow.token || row.token)}`
            });
        }
    }
    return membros;
}

async function getTokenContext(token) {
    const [rows] = await pool.query(
        `SELECT tok.*, j.nome_completo, j.tenant_id, j.numero_ejc_fez, j.montagem_ejc_id, j.origem_ejc_tipo,
                COALESCE(e.numero, m.numero_ejc) AS numero_ejc_atual
         FROM jovens_atualizacao_tokens tok
         JOIN jovens j ON j.id = tok.jovem_id AND j.tenant_id = tok.tenant_id
         LEFT JOIN ejc e ON e.id = COALESCE(tok.ejc_id, j.numero_ejc_fez) AND e.tenant_id = tok.tenant_id
         LEFT JOIN montagens m ON m.id = COALESCE(tok.montagem_id, j.montagem_ejc_id) AND m.tenant_id = tok.tenant_id
         WHERE tok.token = ?
         LIMIT 1`,
        [token]
    );
    const ctx = rows && rows[0] ? rows[0] : null;
    if (!ctx || ctx.invalidado_em) return null;
    return ctx;
}

async function carregarDadosAtuaisJovem(ctx) {
    const [rows] = await pool.query(
        `SELECT j.nome_completo, j.apelido, j.telefone, j.email, j.cpf, j.data_nascimento, j.sexo,
                j.endereco_rua, j.endereco_numero, j.endereco_bairro, j.endereco_cidade, j.endereco_estado, j.endereco_cep,
                j.circulo, j.instagram, j.estado_civil, j.equipe_saude, j.equipe_saude_tipo,
                j.deficiencia, j.qual_deficiencia, j.restricao_alimentar, j.detalhes_restricao,
                j.observacoes_extras, j.eh_musico, j.instrumentos_musicais, j.foto_url, j.origem_ejc_tipo, j.outro_ejc_id
         FROM jovens j
         WHERE j.id = ?
           AND j.tenant_id = ?
         LIMIT 1`,
        [ctx.jovem_id, ctx.tenant_id]
    );
    const jovem = rows && rows[0] ? rows[0] : {};
    await ensurePastoraisTables();
    const [pastoraisRows] = await pool.query(
        'SELECT pastoral_id FROM pastorais_jovens WHERE tenant_id = ? AND jovem_id = ?',
        [ctx.tenant_id, ctx.jovem_id]
    ).catch(() => [[]]);

    return {
        nome_completo: jovem.nome_completo || '',
        apelido: jovem.apelido || '',
        telefone: decryptJovemPhone(jovem.telefone) || '',
        email: decryptJovemEmail(jovem.email) || '',
        cpf: decryptValue(jovem.cpf, 'lista-mestre:cpf') || '',
        data_nascimento: dateToInput(jovem.data_nascimento),
        sexo: jovem.sexo || '',
        endereco_rua: jovem.endereco_rua || '',
        endereco_numero: jovem.endereco_numero || '',
        endereco_bairro: jovem.endereco_bairro || '',
        endereco_cidade: jovem.endereco_cidade || '',
        endereco_estado: jovem.endereco_estado || '',
        endereco_cep: jovem.endereco_cep || '',
        circulo: jovem.circulo || '',
        instagram: jovem.instagram || '',
        estado_civil: jovem.estado_civil || '',
        equipe_saude: Number(jovem.equipe_saude || 0) === 1,
        equipe_saude_tipo: jovem.equipe_saude_tipo || '',
        deficiencia: Number(jovem.deficiencia || 0) === 1,
        qual_deficiencia: decryptValue(jovem.qual_deficiencia, 'lista-mestre:qual-deficiencia') || jovem.qual_deficiencia || '',
        restricao_alimentar: Number(jovem.restricao_alimentar || 0) === 1,
        detalhes_restricao: decryptValue(jovem.detalhes_restricao, 'lista-mestre:detalhes-restricao') || jovem.detalhes_restricao || '',
        informacao_adicional: jovem.observacoes_extras || '',
        pastorais: (pastoraisRows || []).map((row) => Number(row.pastoral_id)).filter((id) => Number.isFinite(id) && id > 0),
        eh_musico: Number(jovem.eh_musico || 0) === 1,
        instrumentos_musicais: parseJsonArraySeguro(jovem.instrumentos_musicais),
        foto_url: jovem.foto_url || '',
        origem_ejc_tipo: String(jovem.origem_ejc_tipo || '').toUpperCase() === 'OUTRO_EJC' || jovem.outro_ejc_id ? 'OUTRO_EJC' : (jovem.origem_ejc_tipo || ''),
        outro_ejc_id: jovem.outro_ejc_id || null
    };
}

router.get('/:token', async (req, res) => {
    try {
        const token = String(req.params.token || '').trim();
        const ctx = await getTokenContext(token);
        if (!ctx) {
            removerUploadTemporario(req.file);
            return res.status(404).json({ error: 'Link inválido ou já utilizado.' });
        }

        await ensurePastoraisTables();
        const [pastorais] = await pool.query('SELECT id, nome FROM pastorais WHERE tenant_id = ? ORDER BY nome', [ctx.tenant_id]);
        const [circulos] = await pool.query('SELECT nome FROM circulos WHERE tenant_id = ? AND ativo = 1 ORDER BY ordem, nome', [ctx.tenant_id]).catch(() => [[]]);
        const [outrosEjcs] = await pool.query('SELECT id, nome, paroquia FROM outros_ejcs WHERE tenant_id = ? ORDER BY paroquia ASC, nome ASC', [ctx.tenant_id]).catch(() => [[]]);
        const [ejcs] = await pool.query('SELECT id, numero, paroquia FROM ejc WHERE tenant_id = ? ORDER BY numero DESC', [ctx.tenant_id]).catch(() => [[]]);
        const dados = await carregarDadosAtuaisJovem(ctx);

        return res.json({
            jovem: {
                id: ctx.jovem_id,
                nome_completo: ctx.nome_completo,
                numero_ejc_atual: ctx.numero_ejc_atual || ''
            },
            dados,
            pastorais: pastorais || [],
            outros_ejcs: outrosEjcs || [],
            ejcs: ejcs || [],
            circulos: (circulos || []).map((row) => row.nome).filter(Boolean),
            instrumentos: ['Voz', 'Violao', 'Guitarra', 'Baixo', 'Teclado', 'Bateria', 'Percussao', 'Flauta', 'Saxofone', 'Violino', 'Cajon', 'Ukulele']
        });
    } catch (err) {
        console.error('Erro ao carregar link mágico de atualização:', err);
        return res.status(500).json({ error: 'Erro ao carregar formulário.' });
    }
});

router.get('/tios/:token', async (req, res) => {
    try {
        const ctx = await getTiosTokenContext(String(req.params.token || '').trim());
        if (!ctx) return res.status(404).json({ error: 'Link inválido ou já utilizado.' });
        const [outrosEjcs] = await pool.query(
            'SELECT id, nome, paroquia FROM outros_ejcs WHERE tenant_id = ? ORDER BY paroquia ASC, nome ASC',
            [ctx.tenant_id]
        ).catch(() => [[]]);
        return res.json({
            casal: {
                id: ctx.casal_id,
                origem_tipo: ctx.origem_tipo || 'EJC',
                outro_ejc_id: ctx.outro_ejc_id || null,
                encontro_tipo: ctx.encontro_tipo || '',
                nome_tio: ctx.nome_tio || '',
                telefone_tio: decryptTioPhone(ctx.telefone_tio) || '',
                cpf_tio: decryptTioCpf(ctx.cpf_tio) || '',
                data_nascimento_tio: dateToInput(ctx.data_nascimento_tio),
                deficiencia_tio: Number(ctx.deficiencia_tio || 0) === 1,
                qual_deficiencia_tio: decryptValue(ctx.qual_deficiencia_tio, 'tios:qual-deficiencia-tio') || ctx.qual_deficiencia_tio || '',
                restricao_alimentar_tio: Number(ctx.restricao_alimentar_tio || 0) === 1,
                detalhes_restricao_tio: decryptValue(ctx.detalhes_restricao_tio, 'tios:detalhes-restricao-tio') || ctx.detalhes_restricao_tio || '',
                possui_carro_tio: Number(ctx.possui_carro_tio || 0) === 1,
                nome_tia: ctx.nome_tia || '',
                telefone_tia: decryptTioPhone(ctx.telefone_tia) || '',
                cpf_tia: decryptTioCpf(ctx.cpf_tia) || '',
                data_nascimento_tia: dateToInput(ctx.data_nascimento_tia),
                deficiencia_tia: Number(ctx.deficiencia_tia || 0) === 1,
                qual_deficiencia_tia: decryptValue(ctx.qual_deficiencia_tia, 'tios:qual-deficiencia-tia') || ctx.qual_deficiencia_tia || '',
                restricao_alimentar_tia: Number(ctx.restricao_alimentar_tia || 0) === 1,
                detalhes_restricao_tia: decryptValue(ctx.detalhes_restricao_tia, 'tios:detalhes-restricao-tia') || ctx.detalhes_restricao_tia || '',
                possui_carro_tia: Number(ctx.possui_carro_tia || 0) === 1
            },
            outros_ejcs: outrosEjcs || []
        });
    } catch (err) {
        console.error('Erro ao carregar atualização de tios:', err);
        return res.status(500).json({ error: 'Erro ao carregar formulário.' });
    }
});

router.post('/tios/:token', express.json(), async (req, res) => {
    try {
        const ctx = await getTiosTokenContext(String(req.params.token || '').trim());
        if (!ctx) return res.status(404).json({ error: 'Link inválido ou já utilizado.' });
        const nomeTio = normalizeUpperText(req.body.nome_tio);
        const nomeTia = normalizeUpperText(req.body.nome_tia);
        const telefoneTio = String(req.body.telefone_tio || '').trim();
        const telefoneTia = String(req.body.telefone_tia || '').trim();
        const cpfTio = String(req.body.cpf_tio || '').trim();
        const cpfTia = String(req.body.cpf_tia || '').trim();
        const encontroTipo = String(req.body.encontro_tipo || '').trim().toUpperCase();
        const origemTipo = String(ctx.origem_tipo || 'EJC').trim().toUpperCase() === 'OUTRO_EJC' ? 'OUTRO_EJC' : 'EJC';
        const outroEjcId = origemTipo === 'OUTRO_EJC' ? Number(req.body.outro_ejc_id || 0) : null;

        if (!nomeTio || !nomeTia || !telefoneTio || !telefoneTia || normalizeCpfDigits(cpfTio).length !== 11 || normalizeCpfDigits(cpfTia).length !== 11) {
            return res.status(400).json({ error: 'Preencha nome, telefone e CPF do tio e da tia.' });
        }
        if (origemTipo === 'EJC' && !['ECC', 'ECNA'].includes(encontroTipo)) {
            return res.status(400).json({ error: 'Selecione ECC ou ECNA.' });
        }
        if (origemTipo === 'OUTRO_EJC') {
            const [rows] = await pool.query('SELECT id FROM outros_ejcs WHERE id = ? AND tenant_id = ? LIMIT 1', [outroEjcId, ctx.tenant_id]);
            if (!rows.length) return res.status(400).json({ error: 'Selecione o EJC de origem.' });
        }

        const defTio = boolValue(req.body.deficiencia_tio);
        const restTio = boolValue(req.body.restricao_alimentar_tio);
        const carroTio = boolValue(req.body.possui_carro_tio);
        const defTia = boolValue(req.body.deficiencia_tia);
        const restTia = boolValue(req.body.restricao_alimentar_tia);
        const carroTia = boolValue(req.body.possui_carro_tia);
        await pool.query(
            `UPDATE tios_casais
             SET nome_tio = ?, telefone_tio = ?, telefone_tio_hash = ?, cpf_tio = ?, cpf_tio_hash = ?, data_nascimento_tio = ?,
                 deficiencia_tio = ?, qual_deficiencia_tio = ?, restricao_alimentar_tio = ?, detalhes_restricao_tio = ?, possui_carro_tio = ?,
                 nome_tia = ?, telefone_tia = ?, telefone_tia_hash = ?, cpf_tia = ?, cpf_tia_hash = ?, data_nascimento_tia = ?,
                 deficiencia_tia = ?, qual_deficiencia_tia = ?, restricao_alimentar_tia = ?, detalhes_restricao_tia = ?, possui_carro_tia = ?,
                 deficiencia = ?, restricao_alimentar = ?, encontro_tipo = ?, outro_ejc_id = ?, termos_aceitos_em = CURRENT_TIMESTAMP
             WHERE id = ? AND tenant_id = ?`,
            [
                nomeTio, encryptTioPhone(telefoneTio), tioPhoneHash(telefoneTio), encryptTioCpf(cpfTio), tioCpfHash(cpfTio), normalizeDate(req.body.data_nascimento_tio),
                defTio ? 1 : 0, defTio ? encryptTioSensitiveText(req.body.qual_deficiencia_tio, 'qual-deficiencia-tio') : null,
                restTio ? 1 : 0, restTio ? encryptTioSensitiveText(req.body.detalhes_restricao_tio, 'detalhes-restricao-tio') : null, carroTio ? 1 : 0,
                nomeTia, encryptTioPhone(telefoneTia), tioPhoneHash(telefoneTia), encryptTioCpf(cpfTia), tioCpfHash(cpfTia), normalizeDate(req.body.data_nascimento_tia),
                defTia ? 1 : 0, defTia ? encryptTioSensitiveText(req.body.qual_deficiencia_tia, 'qual-deficiencia-tia') : null,
                restTia ? 1 : 0, restTia ? encryptTioSensitiveText(req.body.detalhes_restricao_tia, 'detalhes-restricao-tia') : null, carroTia ? 1 : 0,
                (defTio || defTia) ? 1 : 0, (restTio || restTia) ? 1 : 0,
                origemTipo === 'EJC' ? encontroTipo : null, origemTipo === 'OUTRO_EJC' ? outroEjcId : null,
                ctx.casal_id, ctx.tenant_id
            ]
        );
        await pool.query(
            `UPDATE tios_atualizacao_tokens
             SET atualizado = 1, usado_em = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [ctx.id]
        );
        return res.json({ message: 'Cadastro atualizado com sucesso.' });
    } catch (err) {
        console.error('Erro ao salvar atualização de tios:', err);
        return res.status(500).json({ error: 'Erro ao salvar atualização.' });
    }
});

router.get('/equipe/:token', async (req, res) => {
    try {
        const token = String(req.params.token || '').trim();
        const ctx = await carregarContextoEquipe(token);
        if (!ctx) return res.status(404).json({ error: 'Link da equipe inválido.' });

        const membros = await listarMembrosEquipe(ctx, req);
        const total = membros.length;
        const atualizados = membros.filter((item) => item.atualizado).length;
        return res.json({
            equipe: {
                nome: ctx.equipe_nome || 'Equipe',
                tipo: ctx.tipo,
                numero_ejc: ctx.montagem_numero || ctx.ejc_numero || ''
            },
            total,
            atualizados,
            percentual: total ? Math.round((atualizados / total) * 100) : 0,
            membros
        });
    } catch (err) {
        console.error('Erro ao carregar link público da equipe:', err);
        return res.status(500).json({ error: 'Erro ao carregar links da equipe.' });
    }
});

router.post('/:token', upload.single('foto'), async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const token = String(req.params.token || '').trim();
        const ctx = await getTokenContext(token);
        if (!ctx) {
            removerUploadTemporario(req.file);
            return res.status(404).json({ error: 'Link inválido ou já utilizado.' });
        }

        const nome = normalizeUpperText(req.body.nome_completo);
        const apelido = normalizeUpperText(req.body.apelido);
        const telefone = String(req.body.telefone || '').trim();
        const email = String(req.body.email || '').trim();
        const cpf = formatCpf(req.body.cpf);
        const dataNascimento = normalizeDate(req.body.data_nascimento);
        const sexo = ['Feminino', 'Masculino'].includes(req.body.sexo) ? req.body.sexo : '';
        const enderecoRua = normalizeUpperText(req.body.endereco_rua);
        const enderecoNumero = String(req.body.endereco_numero || '').trim();
        const enderecoBairro = normalizeUpperText(req.body.endereco_bairro);
        const enderecoCidade = normalizeUpperText(req.body.endereco_cidade);
        const enderecoEstado = normalizeUpperText(req.body.endereco_estado);
        const enderecoCep = String(req.body.endereco_cep || '').trim();
        const circulo = String(req.body.circulo || '').trim();
        const estadoCivil = String(req.body.estado_civil || '').trim();
        const outroEjcId = req.body.outro_ejc_id ? Number(req.body.outro_ejc_id) : null;
        const aceite = boolValue(req.body.aceite_termos);
        const [fotoAtualRows] = await connection.query(
            'SELECT foto_url, origem_ejc_tipo, outro_ejc_id FROM jovens WHERE id = ? AND tenant_id = ? LIMIT 1',
            [ctx.jovem_id, ctx.tenant_id]
        );
        const fotoAtualUrl = fotoAtualRows && fotoAtualRows[0] ? String(fotoAtualRows[0].foto_url || '') : '';
        const ehOutroEjc = String(fotoAtualRows && fotoAtualRows[0] && fotoAtualRows[0].origem_ejc_tipo || '').toUpperCase() === 'OUTRO_EJC'
            || Number(fotoAtualRows && fotoAtualRows[0] && fotoAtualRows[0].outro_ejc_id || 0) > 0;
        if (
            !nome || !telefone || !email || !cpf || !dataNascimento || !sexo
            || !enderecoRua || !enderecoNumero || !enderecoBairro || !enderecoCidade || !enderecoEstado || !enderecoCep
            || (!ehOutroEjc && !circulo) || !estadoCivil || (ehOutroEjc && (!Number.isFinite(outroEjcId) || outroEjcId <= 0)) || (!req.file && !fotoAtualUrl) || !aceite
        ) {
            removerUploadTemporario(req.file);
            return res.status(400).json({ error: 'Preencha todos os campos obrigatórios e aceite os termos.' });
        }

        const equipeSaude = boolValue(req.body.equipe_saude);
        const deficiencia = boolValue(req.body.deficiencia);
        const restricao = boolValue(req.body.restricao_alimentar);
        const ehMusico = boolValue(req.body.eh_musico);
        const pastoraisIds = ehOutroEjc ? [] : [...new Set(parseJsonArray(req.body.pastorais).map(Number).filter((id) => Number.isFinite(id) && id > 0))];
        const fotoUrl = req.file ? `/uploads/fotos_jovens/${req.file.filename}` : null;
        const informacaoAdicional = String(req.body.informacao_adicional || '').trim() || null;

        await connection.beginTransaction();
        await connection.query(
            `UPDATE jovens
             SET nome_completo = ?,
                 apelido = ?,
                 telefone = ?,
                 telefone_hash = ?,
                 email = ?,
                 email_hash = ?,
                 cpf = ?,
                 cpf_hash = ?,
                 data_nascimento = ?,
                 sexo = ?,
                 endereco_rua = ?,
                 endereco_numero = ?,
                 endereco_bairro = ?,
                 endereco_cidade = ?,
                 endereco_estado = ?,
                 endereco_cep = ?,
                 circulo = ?,
                 instagram = ?,
                 estado_civil = ?,
                 equipe_saude = ?,
                 equipe_saude_tipo = ?,
                 deficiencia = ?,
                 qual_deficiencia = ?,
                 restricao_alimentar = ?,
                 detalhes_restricao = ?,
                 observacoes_extras = ?,
                 eh_musico = ?,
                 instrumentos_musicais = ?,
                 outro_ejc_id = CASE WHEN origem_ejc_tipo = 'OUTRO_EJC' THEN ? ELSE outro_ejc_id END,
                 foto_url = COALESCE(?, foto_url),
                 termos_aceitos_em = CURRENT_TIMESTAMP,
                 termos_aceitos_email = ?
             WHERE id = ? AND tenant_id = ?`,
            [
                nome,
                apelido || null,
                encryptJovemPhone(telefone),
                jovemPhoneHash(telefone),
                encryptJovemEmail(email),
                jovemEmailHash(email),
                encryptCpf(cpf),
                cpfHash(cpf),
                dataNascimento,
                sexo,
                enderecoRua,
                enderecoNumero,
                enderecoBairro,
                enderecoCidade,
                enderecoEstado,
                enderecoCep,
                ehOutroEjc ? null : circulo,
                String(req.body.instagram || '').trim() || null,
                estadoCivil,
                equipeSaude ? 1 : 0,
                equipeSaude ? (String(req.body.equipe_saude_tipo || '').trim() || null) : null,
                deficiencia ? 1 : 0,
                deficiencia ? (String(req.body.qual_deficiencia || '').trim() || null) : null,
                restricao ? 1 : 0,
                restricao ? (String(req.body.detalhes_restricao || '').trim() || null) : null,
                informacaoAdicional,
                ehMusico ? 1 : 0,
                serializeInstrumentos(req.body.instrumentos_musicais, ehMusico),
                Number.isFinite(outroEjcId) && outroEjcId > 0 ? outroEjcId : null,
                fotoUrl,
                email,
                ctx.jovem_id,
                ctx.tenant_id
            ]
        );

        await ensurePastoraisTables();
        await connection.query('DELETE FROM pastorais_jovens WHERE tenant_id = ? AND jovem_id = ?', [ctx.tenant_id, ctx.jovem_id]);
        if (pastoraisIds.length) {
            await connection.query(
                'INSERT INTO pastorais_jovens (tenant_id, pastoral_id, jovem_id) VALUES ?',
                [pastoraisIds.map((id) => [ctx.tenant_id, id, ctx.jovem_id])]
            );
        }

        if (informacaoAdicional) {
            await connection.query(
                `INSERT INTO jovens_atualizacao_comentarios
                 (tenant_id, jovem_id, nome_completo, telefone, comentario)
                 VALUES (?, ?, ?, ?, ?)`,
                [ctx.tenant_id, ctx.jovem_id, nome, telefone, informacaoAdicional]
            );
        }

        const solicitacoes = [];
        if (String(req.body.confirmou_edicao || '').toLowerCase() === 'nao') {
            solicitacoes.push(['edicao', `Você fez o ${ctx.numero_ejc_atual || ''} EJC?`, 'Não', { edicao_informada: req.body.edicao_correta || '' }]);
        }
        if (boolValue(req.body.ja_foi_garcom)) {
            solicitacoes.push(['garcom', 'Você já foi Garçom?', 'Sim', {
                numero_ejc: req.body.garcom_numero_ejc || '',
                ejc: req.body.garcom_ejc || '',
                funcao: req.body.garcom_funcao || ''
            }]);
        }
        if (boolValue(req.body.ja_foi_moita)) {
            solicitacoes.push(['moita', 'Você já foi Moita?', 'Sim', {
                numero_ejc: req.body.moita_numero_ejc || '',
                ejc: req.body.moita_ejc || '',
                papel: req.body.moita_papel || ''
            }]);
        }
        for (const item of solicitacoes) {
            // eslint-disable-next-line no-await-in-loop
            await connection.query(
                `INSERT INTO jovens_atualizacao_solicitacoes
                 (tenant_id, token_id, jovem_id, tipo, pergunta, resposta, dados_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [ctx.tenant_id, ctx.id, ctx.jovem_id, item[0], item[1], item[2], JSON.stringify(item[3])]
            );
        }

        await connection.query(
            `UPDATE jovens_atualizacao_tokens
             SET atualizado = 1, usado_em = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [ctx.id]
        );
        await connection.commit();
        return res.json({ message: 'Cadastro atualizado com sucesso.' });
    } catch (err) {
        await connection.rollback().catch(() => {});
        removerUploadTemporario(req.file);
        console.error('Erro ao salvar atualização por link mágico:', err);
        return res.status(500).json({ error: 'Erro ao salvar atualização.' });
    } finally {
        connection.release();
    }
});

router.use((err, _req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'A foto é muito grande. Envie uma imagem com até 5 MB.' });
        }
        return res.status(400).json({ error: err.message || 'Não foi possível receber a foto.' });
    }
    return next(err);
});

module.exports = router;
