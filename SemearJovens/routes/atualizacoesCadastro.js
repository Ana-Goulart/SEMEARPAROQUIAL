const express = require('express');
const crypto = require('crypto');
const { pool } = require('../database');
const { getTenantId } = require('../lib/tenantIsolation');

const router = express.Router();

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

function parseJsonSeguro(valor) {
    if (!valor) return {};
    if (typeof valor !== 'string') return valor;
    try {
        return JSON.parse(valor);
    } catch (_) {
        return {};
    }
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
    const [hasObsRows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'jovens_atualizacao_nao_encontrado'
          AND COLUMN_NAME = 'observacoes_adicionais'
    `);
    if (!hasObsRows[0]?.cnt) {
        await pool.query('ALTER TABLE jovens_atualizacao_nao_encontrado ADD COLUMN observacoes_adicionais TEXT NULL AFTER ejc_que_fez');
    }
    const [hasOrigemRows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'jovens_atualizacao_nao_encontrado'
          AND COLUMN_NAME = 'origem_formulario'
    `);
    if (!hasOrigemRows[0]?.cnt) {
        await pool.query('ALTER TABLE jovens_atualizacao_nao_encontrado ADD COLUMN origem_formulario VARCHAR(120) NULL AFTER observacoes_adicionais');
    }
}

router.get('/comentarios', async (req, res) => {
    try {
        await ensureAtualizacaoTables();
        const tenantId = getTenantId(req);
        const [rows] = await pool.query(
            `SELECT id, nome_completo, telefone, comentario, created_at
             FROM jovens_atualizacao_comentarios
             WHERE tenant_id = ?
             ORDER BY created_at DESC`,
            [tenantId]
        );
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar comentários:', err);
        return res.status(500).json({ error: 'Erro ao listar comentários.' });
    }
});

router.get('/nao-encontrados', async (req, res) => {
    try {
        await ensureAtualizacaoTables();
        const tenantId = getTenantId(req);
        const [rows] = await pool.query(
            `SELECT id, nome_completo, telefone, ejc_que_fez, observacoes_adicionais, origem_formulario, created_at
             FROM jovens_atualizacao_nao_encontrado
             WHERE tenant_id = ?
             ORDER BY created_at DESC`,
            [tenantId]
        );
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar não encontrados:', err);
        return res.status(500).json({ error: 'Erro ao listar não encontrados.' });
    }
});

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

async function obterOuCriarTokenEquipeAtualizacao({ tenantId, tipo, ejcId = null, montagemId = null, equipeId }) {
    const tipoNormalizado = String(tipo || '').trim().toLowerCase() === 'montagem' ? 'montagem' : 'edicao';
    const [existentes] = await pool.query(
        `SELECT id, token
         FROM equipes_atualizacao_tokens
         WHERE tenant_id = ?
           AND tipo = ?
           AND (ejc_id <=> ?)
           AND (montagem_id <=> ?)
           AND equipe_id = ?
           AND invalidado_em IS NULL
         LIMIT 1`,
        [tenantId, tipoNormalizado, ejcId, montagemId, equipeId]
    );
    if (existentes.length) return existentes[0];

    const token = gerarTokenAtualizacao();
    const [result] = await pool.query(
        `INSERT INTO equipes_atualizacao_tokens (tenant_id, tipo, ejc_id, montagem_id, equipe_id, token)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [tenantId, tipoNormalizado, ejcId, montagemId, equipeId, token]
    );
    return { id: result.insertId, token };
}

function contextoEquipePorQuery(req) {
    const tipo = String(req.query.tipo || 'edicao').trim().toLowerCase() === 'montagem' ? 'montagem' : 'edicao';
    const equipeId = Number(req.query.equipe_id || 0);
    const ejcId = tipo === 'montagem' ? null : Number(req.query.ejc_id || 0);
    const montagemId = tipo === 'montagem' ? Number(req.query.montagem_id || 0) : null;
    return { tipo, equipeId, ejcId, montagemId };
}

router.get('/jovem-link', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const jovemId = Number(req.query.jovem_id || 0);
        if (!jovemId) return res.status(400).json({ error: 'Informe o jovem_id.' });

        const tokenRow = await obterOuCriarTokenAtualizacao({ tenantId, jovemId });
        return res.json({
            link: `${publicBaseUrl(req)}/atualizar/${encodeURIComponent(tokenRow.token)}`
        });
    } catch (err) {
        console.error('Erro ao gerar link de atualização do jovem:', err);
        return res.status(500).json({ error: 'Erro ao gerar link do jovem.' });
    }
});

router.get('/equipe-link', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const { tipo, equipeId, ejcId, montagemId } = contextoEquipePorQuery(req);
        if (tipo !== 'montagem') {
            return res.status(400).json({ error: 'Formulário disponível apenas para montagens em andamento.' });
        }
        if (!equipeId || (!ejcId && !montagemId)) {
            return res.status(400).json({ error: 'Informe equipe e edição/montagem.' });
        }

        const tokenRow = await obterOuCriarTokenEquipeAtualizacao({ tenantId, tipo, ejcId, montagemId, equipeId });
        return res.json({
            link: `${publicBaseUrl(req)}/formulario-equipe/${encodeURIComponent(tokenRow.token)}`
        });
    } catch (err) {
        console.error('Erro ao gerar link de formulário da equipe:', err);
        return res.status(500).json({ error: 'Erro ao gerar link da equipe.' });
    }
});

router.get('/equipe-links', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const { tipo, equipeId, ejcId, montagemId } = contextoEquipePorQuery(req);
        if (tipo !== 'montagem') {
            return res.status(400).json({ error: 'Formulário disponível apenas para montagens em andamento.' });
        }

        if (!equipeId || (!ejcId && !montagemId)) {
            return res.status(400).json({ error: 'Informe equipe e edição/montagem.' });
        }

        let rows = [];
        if (montagemId) {
            [rows] = await pool.query(
                `SELECT DISTINCT j.id AS jovem_id, j.nome_completo, ef.nome AS subfuncao,
                        tok.token, tok.atualizado, tok.usado_em, tok.invalidado_em
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
                `SELECT DISTINCT j.id AS jovem_id, j.nome_completo, he.subfuncao,
                        tok.token, tok.atualizado, tok.usado_em, tok.invalidado_em
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
            const token = tokenRow.token || row.token;
            membros.push({
                jovem_id: Number(row.jovem_id),
                nome_completo: row.nome_completo,
                subfuncao: row.subfuncao || '',
                atualizado: Number(row.atualizado || tokenRow.atualizado || 0) === 1,
                link: `${baseUrl}/atualizar/${encodeURIComponent(token)}`
            });
        }

        const total = membros.length;
        const atualizados = membros.filter((item) => item.atualizado).length;
        return res.json({
            total,
            atualizados,
            percentual: total ? Math.round((atualizados / total) * 100) : 0,
            membros
        });
    } catch (err) {
        console.error('Erro ao gerar links de atualização da equipe:', err);
        return res.status(500).json({ error: 'Erro ao gerar links de atualização.' });
    }
});

router.get('/solicitacoes', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const [rows] = await pool.query(
            `SELECT s.id, s.tipo, s.pergunta, s.resposta, s.dados_json, s.status, s.criado_em,
                    j.nome_completo
             FROM jovens_atualizacao_solicitacoes s
             JOIN jovens j ON j.id = s.jovem_id AND j.tenant_id = s.tenant_id
             WHERE s.tenant_id = ?
             ORDER BY s.criado_em DESC`,
            [tenantId]
        );
        return res.json((rows || []).map((row) => ({
            ...row,
            dados: parseJsonSeguro(row.dados_json)
        })));
    } catch (err) {
        console.error('Erro ao listar solicitações de atualização:', err);
        return res.status(500).json({ error: 'Erro ao listar solicitações.' });
    }
});

router.patch('/solicitacoes/:id', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const id = Number(req.params.id || 0);
        const status = String(req.body && req.body.status || '').trim().toLowerCase();
        const observacao = String(req.body && req.body.observacao_admin || '').trim() || null;
        const permitidos = new Set(['pendente', 'aprovado', 'rejeitado']);

        if (!id || !permitidos.has(status)) {
            return res.status(400).json({ error: 'Solicitação ou status inválido.' });
        }

        const [result] = await pool.query(
            `UPDATE jovens_atualizacao_solicitacoes
             SET status = ?,
                 observacao_admin = ?,
                 avaliado_em = CASE WHEN ? = 'pendente' THEN NULL ELSE NOW() END,
                 avaliado_por = CASE WHEN ? = 'pendente' THEN NULL ELSE ? END
             WHERE id = ?
               AND tenant_id = ?`,
            [status, observacao, status, status, req.session?.user?.id || null, id, tenantId]
        );

        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Solicitação não encontrada.' });
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('Erro ao atualizar solicitação de atualização:', err);
        return res.status(500).json({ error: 'Erro ao atualizar solicitação.' });
    }
});

module.exports = router;
