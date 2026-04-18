const express = require('express');
const { pool } = require('../database');

const router = express.Router();
const MODULE_CODE = 'semear-jovens';
const STATUS_NOVA = 'NOVA';
const STATUS_EM_ANALISE = 'EM_ANALISE';
const STATUS_SOLUCIONADA = 'SOLUCIONADA';
const STATUS_ENCERRADA = 'ENCERRADA';
const AUTOR_USUARIO = 'USUARIO';

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

async function ensureSupportMessagesStructure() {
    if (!await hasTable('support_messages')) {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS support_messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tenant_id INT NULL,
                module_code VARCHAR(80) NOT NULL,
                user_id INT NULL,
                user_nome VARCHAR(180) NOT NULL,
                user_login VARCHAR(180) NULL,
                assunto VARCHAR(180) NOT NULL,
                mensagem TEXT NOT NULL,
                status VARCHAR(30) NOT NULL DEFAULT 'NOVA',
                lida_em DATETIME NULL,
                respondida_em DATETIME NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                KEY idx_support_messages_tenant (tenant_id),
                KEY idx_support_messages_module (module_code),
                KEY idx_support_messages_status (status),
                KEY idx_support_messages_user (user_id)
            )
        `);
        return;
    }

    if (!await hasColumn('support_messages', 'tenant_id')) {
        await pool.query('ALTER TABLE support_messages ADD COLUMN tenant_id INT NULL AFTER id');
    }
    if (!await hasColumn('support_messages', 'module_code')) {
        await pool.query("ALTER TABLE support_messages ADD COLUMN module_code VARCHAR(80) NOT NULL DEFAULT 'semear-jovens' AFTER tenant_id");
    }
    if (!await hasColumn('support_messages', 'user_id')) {
        await pool.query('ALTER TABLE support_messages ADD COLUMN user_id INT NULL AFTER module_code');
    }
    if (!await hasColumn('support_messages', 'user_nome')) {
        await pool.query('ALTER TABLE support_messages ADD COLUMN user_nome VARCHAR(180) NOT NULL AFTER user_id');
    }
    if (!await hasColumn('support_messages', 'user_login')) {
        await pool.query('ALTER TABLE support_messages ADD COLUMN user_login VARCHAR(180) NULL AFTER user_nome');
    }
    if (!await hasColumn('support_messages', 'assunto')) {
        await pool.query('ALTER TABLE support_messages ADD COLUMN assunto VARCHAR(180) NOT NULL AFTER user_login');
    }
    if (!await hasColumn('support_messages', 'mensagem')) {
        await pool.query('ALTER TABLE support_messages ADD COLUMN mensagem TEXT NOT NULL AFTER assunto');
    }
    if (!await hasColumn('support_messages', 'status')) {
        await pool.query("ALTER TABLE support_messages ADD COLUMN status VARCHAR(30) NOT NULL DEFAULT 'NOVA' AFTER mensagem");
    }
    if (!await hasColumn('support_messages', 'lida_em')) {
        await pool.query('ALTER TABLE support_messages ADD COLUMN lida_em DATETIME NULL AFTER status');
    }
    if (!await hasColumn('support_messages', 'respondida_em')) {
        await pool.query('ALTER TABLE support_messages ADD COLUMN respondida_em DATETIME NULL AFTER lida_em');
    }
    if (!await hasColumn('support_messages', 'solucionada_em')) {
        await pool.query('ALTER TABLE support_messages ADD COLUMN solucionada_em DATETIME NULL AFTER respondida_em');
    }
    if (!await hasColumn('support_messages', 'confirmada_em')) {
        await pool.query('ALTER TABLE support_messages ADD COLUMN confirmada_em DATETIME NULL AFTER solucionada_em');
    }
    if (!await hasColumn('support_messages', 'confirmada_por_user_id')) {
        await pool.query('ALTER TABLE support_messages ADD COLUMN confirmada_por_user_id INT NULL AFTER confirmada_em');
    }

    if (!await hasTable('support_message_replies')) {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS support_message_replies (
                id INT AUTO_INCREMENT PRIMARY KEY,
                support_message_id INT NOT NULL,
                tenant_id INT NULL,
                author_type VARCHAR(30) NOT NULL,
                author_name VARCHAR(180) NOT NULL,
                author_login VARCHAR(180) NULL,
                message TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                KEY idx_support_message_replies_message (support_message_id),
                KEY idx_support_message_replies_tenant (tenant_id)
            )
        `);
    }
}

async function getCurrentUser(req) {
    const userId = Number(req.user && req.user.id);
    if (!Number.isInteger(userId) || userId <= 0) return null;

    const [rows] = await pool.query(
        `SELECT u.id, u.tenant_id, u.nome_completo, u.username,
                t.nome_ejc, t.paroquia
         FROM usuarios u
         LEFT JOIN tenants_ejc t ON t.id = u.tenant_id
         WHERE u.id = ?
         LIMIT 1`,
        [userId]
    );
    return rows && rows[0] ? rows[0] : null;
}

function normalizeReplyRows(rows, fallbackMessage) {
    const list = Array.isArray(rows) ? [...rows] : [];
    if (!list.length && fallbackMessage && fallbackMessage.mensagem) {
        list.push({
            id: `legacy-${fallbackMessage.id}`,
            author_type: AUTOR_USUARIO,
            author_name: fallbackMessage.user_nome,
            author_login: fallbackMessage.user_login,
            message: fallbackMessage.mensagem,
            created_at: fallbackMessage.created_at
        });
    }
    return list;
}

async function loadRepliesByMessageIds(messageIds) {
    const ids = Array.isArray(messageIds)
        ? messageIds.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
        : [];
    if (!ids.length) return new Map();

    const [rows] = await pool.query(
        `SELECT id, support_message_id, author_type, author_name, author_login, message, created_at
         FROM support_message_replies
         WHERE support_message_id IN (?)
         ORDER BY created_at ASC, id ASC`,
        [ids]
    );

    const map = new Map();
    for (const row of rows) {
        const key = Number(row.support_message_id);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(row);
    }
    return map;
}

router.get('/', async (req, res) => {
    try {
        await ensureSupportMessagesStructure();
        const usuario = await getCurrentUser(req);
        if (!usuario) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }

        const [mensagens] = await pool.query(
            `SELECT id, tenant_id, user_id, user_nome, user_login, assunto, mensagem, status, created_at, updated_at,
                    lida_em, respondida_em, solucionada_em, confirmada_em, confirmada_por_user_id
             FROM support_messages
             WHERE tenant_id = ?
               AND module_code = ?
             ORDER BY created_at DESC`,
            [usuario.tenant_id, MODULE_CODE]
        );
        const repliesMap = await loadRepliesByMessageIds(mensagens.map((item) => item.id));
        const mensagensComConversa = mensagens.map((item) => ({
            ...item,
            conversa: normalizeReplyRows(repliesMap.get(Number(item.id)), item)
        }));

        return res.json({
            usuario: {
                id: usuario.id,
                nome_completo: usuario.nome_completo,
                username: usuario.username,
                tenant_id: usuario.tenant_id,
                nome_ejc: usuario.nome_ejc,
                paroquia: usuario.paroquia
            },
            mensagens: mensagensComConversa
        });
    } catch (err) {
        console.error('Erro ao listar mensagens de ajuda:', err);
        return res.status(500).json({ error: 'Erro ao carregar ajuda.' });
    }
});

router.post('/', async (req, res) => {
    try {
        await ensureSupportMessagesStructure();
        const usuario = await getCurrentUser(req);
        if (!usuario) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }

        const assunto = String(req.body.assunto || '').trim();
        const mensagem = String(req.body.mensagem || '').trim();

        if (!assunto || !mensagem) {
            return res.status(400).json({ error: 'Preencha assunto e mensagem.' });
        }
        if (assunto.length > 180) {
            return res.status(400).json({ error: 'O assunto pode ter no máximo 180 caracteres.' });
        }
        if (mensagem.length < 10) {
            return res.status(400).json({ error: 'Escreva um pouco mais de detalhe na mensagem.' });
        }

        const [result] = await pool.query(
            `INSERT INTO support_messages
             (tenant_id, module_code, user_id, user_nome, user_login, assunto, mensagem, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                usuario.tenant_id || null,
                MODULE_CODE,
                usuario.id,
                String(usuario.nome_completo || '').trim() || 'Usuário',
                String(usuario.username || '').trim() || null,
                assunto,
                mensagem,
                STATUS_NOVA
            ]
        );
        await pool.query(
            `INSERT INTO support_message_replies
             (support_message_id, tenant_id, author_type, author_name, author_login, message)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                result.insertId,
                usuario.tenant_id || null,
                AUTOR_USUARIO,
                String(usuario.nome_completo || '').trim() || 'Usuário',
                String(usuario.username || '').trim() || null,
                mensagem
            ]
        );

        return res.status(201).json({
            id: result.insertId,
            message: 'Mensagem enviada com sucesso. A administradora verá esse pedido no painel.'
        });
    } catch (err) {
        console.error('Erro ao enviar mensagem de ajuda:', err);
        return res.status(500).json({ error: 'Erro ao enviar mensagem de ajuda.' });
    }
});

router.post('/:id/replies', async (req, res) => {
    try {
        await ensureSupportMessagesStructure();
        const usuario = await getCurrentUser(req);
        if (!usuario) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }

        const supportMessageId = Number(req.params.id);
        const message = String(req.body.message || '').trim();
        if (!Number.isInteger(supportMessageId) || supportMessageId <= 0) {
            return res.status(400).json({ error: 'Mensagem de ajuda inválida.' });
        }
        if (!message || message.length < 2) {
            return res.status(400).json({ error: 'Escreva a mensagem da conversa.' });
        }

        const [[ticket]] = await pool.query(
            `SELECT id, status
             FROM support_messages
             WHERE id = ?
               AND tenant_id = ?
               AND module_code = ?
             LIMIT 1`,
            [supportMessageId, usuario.tenant_id, MODULE_CODE]
        );
        if (!ticket) {
            return res.status(404).json({ error: 'Pedido de ajuda não encontrado para este EJC.' });
        }
        if (String(ticket.status || '').trim() === STATUS_ENCERRADA) {
            return res.status(400).json({ error: 'Este chamado já foi encerrado.' });
        }

        await pool.query(
            `INSERT INTO support_message_replies
             (support_message_id, tenant_id, author_type, author_name, author_login, message)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                supportMessageId,
                usuario.tenant_id || null,
                AUTOR_USUARIO,
                String(usuario.nome_completo || '').trim() || 'Usuário',
                String(usuario.username || '').trim() || null,
                message
            ]
        );
        await pool.query(
            `UPDATE support_messages
             SET status = ?,
                 respondida_em = NULL,
                 solucionada_em = NULL,
                 confirmada_em = NULL,
                 confirmada_por_user_id = NULL
             WHERE id = ?`,
            [STATUS_EM_ANALISE, supportMessageId]
        );

        return res.status(201).json({ message: 'Mensagem enviada na conversa com sucesso.' });
    } catch (err) {
        console.error('Erro ao responder pedido de ajuda:', err);
        return res.status(500).json({ error: 'Erro ao enviar resposta.' });
    }
});

router.post('/:id/confirmar', async (req, res) => {
    try {
        await ensureSupportMessagesStructure();
        const usuario = await getCurrentUser(req);
        if (!usuario) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }

        const supportMessageId = Number(req.params.id);
        if (!Number.isInteger(supportMessageId) || supportMessageId <= 0) {
            return res.status(400).json({ error: 'Chamado inválido.' });
        }

        const [[ticket]] = await pool.query(
            `SELECT id, status
             FROM support_messages
             WHERE id = ?
               AND tenant_id = ?
               AND module_code = ?
             LIMIT 1`,
            [supportMessageId, usuario.tenant_id, MODULE_CODE]
        );
        if (!ticket) {
            return res.status(404).json({ error: 'Chamado não encontrado para este EJC.' });
        }
        if (String(ticket.status || '').trim() !== STATUS_SOLUCIONADA) {
            return res.status(400).json({ error: 'Este chamado ainda não está aguardando confirmação.' });
        }

        await pool.query(
            `UPDATE support_messages
             SET status = ?,
                 confirmada_em = NOW(),
                 confirmada_por_user_id = ?
             WHERE id = ?`,
            [STATUS_ENCERRADA, usuario.id, supportMessageId]
        );

        return res.json({ message: 'Chamado confirmado e encerrado com sucesso.' });
    } catch (err) {
        console.error('Erro ao confirmar solução do chamado:', err);
        return res.status(500).json({ error: 'Erro ao confirmar o chamado.' });
    }
});

module.exports = router;
