const express = require('express');
const crypto = require('crypto');
const { pool, corePool } = require('../database');

const router = express.Router();
const CORE_PARISH_CODE = String(process.env.CORE_PARISH_CODE || 'inconfidentes').trim();
const CORE_SYSTEM_CODE = String(process.env.CORE_SYSTEM_CODE || 'semear-catequese').trim();
const CORE_LEGACY_SOURCE = String(process.env.CORE_LEGACY_SOURCE || 'db_semearcatequese_infantil').trim();

let coreContextCache = null;

function hashPassword(password) {
    return crypto.createHash('sha256').update(String(password)).digest('hex');
}

async function getCoreContext(connection) {
    if (coreContextCache) return coreContextCache;
    const [[parish]] = await connection.query(
        'SELECT id, code FROM parishes WHERE code = ? AND active = 1 LIMIT 1',
        [CORE_PARISH_CODE]
    );
    const [[system]] = await connection.query(
        'SELECT id, code FROM systems WHERE code = ? AND active = 1 LIMIT 1',
        [CORE_SYSTEM_CODE]
    );
    if (!parish) throw new Error(`Paróquia não encontrada no semear_core: ${CORE_PARISH_CODE}`);
    if (!system) throw new Error(`Sistema não encontrado no semear_core: ${CORE_SYSTEM_CODE}`);
    coreContextCache = { parishId: Number(parish.id), systemId: Number(system.id) };
    return coreContextCache;
}

async function syncCoreAccess({
    email,
    emailHint,
    nomeCompleto,
    senhaHash,
    grupo,
    ativo,
    legacyUserId
}) {
    const loginEmail = String(email || '').trim().toLowerCase();
    if (!loginEmail) throw new Error('E-mail do usuário inválido para sincronização no semear_core.');

    const conn = await corePool.getConnection();
    try {
        await conn.beginTransaction();
        const { parishId, systemId } = await getCoreContext(conn);

        const hints = [];
        const rawHint = String(emailHint || '').trim().toLowerCase();
        if (rawHint && rawHint !== loginEmail) hints.push(rawHint);
        hints.push(loginEmail);

        let user = null;
        for (const candidate of hints) {
            const [rows] = await conn.query(
                'SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1',
                [candidate]
            );
            if (rows.length) {
                user = rows[0];
                break;
            }
        }

        let coreUserId = 0;
        if (user) {
            coreUserId = Number(user.id);
            let updateQuery = 'UPDATE users SET nome = ?, email = ?, active = ?, updated_at = CURRENT_TIMESTAMP';
            const updateParams = [String(nomeCompleto).trim(), loginEmail, ativo ? 1 : 0];
            if (senhaHash) {
                updateQuery += ', password_hash_legacy = ?';
                updateParams.push(senhaHash);
            }
            if (legacyUserId > 0) {
                updateQuery += ', legacy_source = COALESCE(legacy_source, ?), legacy_user_id = COALESCE(legacy_user_id, ?)';
                updateParams.push(CORE_LEGACY_SOURCE, legacyUserId);
            }
            updateQuery += ' WHERE id = ?';
            updateParams.push(coreUserId);
            await conn.query(updateQuery, updateParams);
        } else {
            const [insertResult] = await conn.query(
                `INSERT INTO users (legacy_source, legacy_user_id, parish_id, nome, email, password_hash_legacy, active)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    CORE_LEGACY_SOURCE,
                    legacyUserId > 0 ? legacyUserId : null,
                    parishId,
                    String(nomeCompleto).trim(),
                    loginEmail,
                    senhaHash || null,
                    ativo ? 1 : 0
                ]
            );
            coreUserId = Number(insertResult.insertId);
        }

        const [accessRows] = await conn.query(
            `SELECT id
             FROM user_access
             WHERE user_id = ? AND parish_id = ? AND system_id = ?
             LIMIT 1`,
            [coreUserId, parishId, systemId]
        );

        if (accessRows.length) {
            await conn.query(
                `UPDATE user_access
                 SET role_name = ?, active = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [String(grupo).trim(), ativo ? 1 : 0, accessRows[0].id]
            );
        } else {
            await conn.query(
                `INSERT INTO user_access (user_id, parish_id, system_id, role_name, active)
                 VALUES (?, ?, ?, ?, ?)`,
                [coreUserId, parishId, systemId, String(grupo).trim(), ativo ? 1 : 0]
            );
        }

        await conn.commit();
        return coreUserId;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

async function removeCoreAccessByEmail(email) {
    const loginEmail = String(email || '').trim().toLowerCase();
    if (!loginEmail) return;

    const conn = await corePool.getConnection();
    try {
        await conn.beginTransaction();
        const { parishId, systemId } = await getCoreContext(conn);
        const [userRows] = await conn.query(
            'SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1',
            [loginEmail]
        );
        if (!userRows.length) {
            await conn.commit();
            return;
        }

        await conn.query(
            `DELETE FROM user_access
             WHERE user_id = ? AND parish_id = ? AND system_id = ?`,
            [userRows[0].id, parishId, systemId]
        );
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

router.get('/', async (_req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT id, nome_completo, username, grupo, ativo, created_at, updated_at
             FROM usuarios
             ORDER BY nome_completo ASC`
        );
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao listar usuários.' });
    }
});

router.post('/', async (req, res) => {
    const { nome_completo, username, senha, grupo, ativo } = req.body || {};

    if (!nome_completo || !username || !senha || !grupo) {
        return res.status(400).json({ error: 'Preencha nome, usuário, senha e grupo.' });
    }

    try {
        const senhaHash = hashPassword(senha);
        const [result] = await pool.query(
            `INSERT INTO usuarios (nome_completo, username, senha, grupo, ativo)
             VALUES (?, ?, ?, ?, ?)`,
            [String(nome_completo).trim(), String(username).trim(), senhaHash, String(grupo).trim(), ativo ? 1 : 0]
        );

        try {
            await syncCoreAccess({
                email: String(username).trim(),
                nomeCompleto: String(nome_completo).trim(),
                senhaHash,
                grupo: String(grupo).trim(),
                ativo: !!ativo,
                legacyUserId: Number(result.insertId)
            });
        } catch (coreErr) {
            await pool.query('DELETE FROM usuarios WHERE id = ?', [Number(result.insertId)]);
            throw coreErr;
        }

        return res.status(201).json({ id: result.insertId, message: 'Usuário criado com sucesso.' });
    } catch (err) {
        console.error(err);
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Nome de usuário já existe.' });
        }
        return res.status(500).json({ error: 'Erro ao criar usuário.' });
    }
});

router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { nome_completo, username, senha, grupo, ativo } = req.body || {};

    if (!nome_completo || !username || !grupo) {
        return res.status(400).json({ error: 'Preencha nome, usuário e grupo.' });
    }

    try {
        const [currentRows] = await pool.query(
            'SELECT id, username FROM usuarios WHERE id = ? LIMIT 1',
            [Number(id)]
        );
        if (!currentRows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
        const previousUsername = String(currentRows[0].username || '').trim();

        let query = `UPDATE usuarios SET nome_completo = ?, username = ?, grupo = ?, ativo = ?`;
        const params = [String(nome_completo).trim(), String(username).trim(), String(grupo).trim(), ativo ? 1 : 0];
        let senhaHash = '';

        if (senha && String(senha).trim()) {
            query += ', senha = ?';
            senhaHash = hashPassword(senha);
            params.push(senhaHash);
        }

        query += ' WHERE id = ?';
        params.push(Number(id));

        const [result] = await pool.query(query, params);
        if (!result.affectedRows) return res.status(404).json({ error: 'Usuário não encontrado.' });

        await syncCoreAccess({
            email: String(username).trim(),
            emailHint: previousUsername,
            nomeCompleto: String(nome_completo).trim(),
            senhaHash: senhaHash || null,
            grupo: String(grupo).trim(),
            ativo: !!ativo,
            legacyUserId: Number(id)
        });

        return res.json({ message: 'Usuário atualizado com sucesso.' });
    } catch (err) {
        console.error(err);
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Nome de usuário já existe.' });
        }
        return res.status(500).json({ error: 'Erro ao atualizar usuário.' });
    }
});

router.delete('/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const [currentRows] = await pool.query(
            'SELECT id, username FROM usuarios WHERE id = ? LIMIT 1',
            [Number(id)]
        );
        if (!currentRows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });

        const [result] = await pool.query('DELETE FROM usuarios WHERE id = ?', [Number(id)]);
        if (!result.affectedRows) return res.status(404).json({ error: 'Usuário não encontrado.' });

        await removeCoreAccessByEmail(currentRows[0].username);
        return res.json({ message: 'Usuário excluído com sucesso.' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Erro ao excluir usuário.' });
    }
});

module.exports = router;
