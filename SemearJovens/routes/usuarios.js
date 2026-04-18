const express = require('express');
const router = express.Router();
const { pool, corePool } = require('../database');
const crypto = require('crypto');
const { purgeExpiredUsers } = require('../lib/usuariosExpiracao');
const { getTenantId } = require('../lib/tenantIsolation');

const CORE_PARISH_CODE = String(process.env.CORE_PARISH_CODE || 'inconfidentes').trim();
const CORE_PARISH_NAME = String(process.env.CORE_PARISH_NAME || 'EJC Inconfidentes').trim();
const CORE_SYSTEM_CODE = String(process.env.CORE_SYSTEM_CODE || 'semear-jovens').trim();
const CORE_SYSTEM_NAME = String(process.env.CORE_SYSTEM_NAME || 'EJC').trim();
const CORE_SYSTEM_DOMAIN_RAW = String(
    process.env.CORE_SYSTEM_DOMAIN
    || process.env.SEMEAR_JOVENS_DASHBOARD_URL
    || process.env.DEFAULT_AFTER_LOGIN_URL
    || 'ejc.semearparoquial.com.br:3003'
).trim();
const CORE_LEGACY_SOURCE = String(process.env.CORE_LEGACY_SOURCE || 'db_semeajovens').trim();

let coreContextCache = null;

async function isManagedByParishAdmin(tenantId, email) {
    const tenant = Number(tenantId || 0);
    const loginEmail = String(email || '').trim().toLowerCase();
    if (!tenant || !loginEmail) return false;

    const [rows] = await pool.query(
        `SELECT id
         FROM tenant_module_users
         WHERE tenant_id = ?
           AND module_code = 'semear-jovens'
           AND ativo = 1
           AND LOWER(email) = LOWER(?)
         LIMIT 1`,
        [tenant, loginEmail]
    );
    return rows.length > 0;
}

function resolveCoreSystemDomain() {
    const raw = CORE_SYSTEM_DOMAIN_RAW;
    if (!raw) return 'ejc.semearparoquial.com.br:3003';
    if (/^https?:\/\//i.test(raw)) {
        try {
            return new URL(raw).host || 'ejc.semearparoquial.com.br:3003';
        } catch (_) {
            return 'ejc.semearparoquial.com.br:3003';
        }
    }
    return raw.replace(/^\/+|\/+$/g, '') || 'ejc.semearparoquial.com.br:3003';
}

async function getCoreContext() {
    if (coreContextCache) return coreContextCache;
    const connection = await corePool.getConnection();
    let parishId;
    let systemId;
    try {
        await connection.beginTransaction();

        const [parishRows] = await connection.query(
            'SELECT id FROM parishes WHERE code = ? LIMIT 1',
            [CORE_PARISH_CODE]
        );
        if (parishRows.length) {
            parishId = Number(parishRows[0].id);
            await connection.query('UPDATE parishes SET active = 1 WHERE id = ?', [parishId]);
        } else {
            const [insParish] = await connection.query(
                'INSERT INTO parishes (code, name, active) VALUES (?, ?, 1)',
                [CORE_PARISH_CODE, CORE_PARISH_NAME]
            );
            parishId = Number(insParish.insertId);
        }

        const systemDomain = resolveCoreSystemDomain();
        const [systemRows] = await connection.query(
            'SELECT id FROM systems WHERE code = ? LIMIT 1',
            [CORE_SYSTEM_CODE]
        );
        if (systemRows.length) {
            systemId = Number(systemRows[0].id);
            await connection.query('UPDATE systems SET active = 1, domain = ? WHERE id = ?', [systemDomain, systemId]);
        } else {
            const [insSystem] = await connection.query(
                'INSERT INTO systems (code, name, domain, active) VALUES (?, ?, ?, 1)',
                [CORE_SYSTEM_CODE, CORE_SYSTEM_NAME, systemDomain]
            );
            systemId = Number(insSystem.insertId);
        }

        await connection.commit();
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally {
        connection.release();
    }

    coreContextCache = { parishId: Number(parishId), systemId: Number(systemId) };
    return coreContextCache;
}

async function findExistingCentralLogin(connection, email) {
    const loginEmail = String(email || '').trim().toLowerCase();
    if (!loginEmail) return null;

    const [rows] = await connection.query(
        `SELECT u.id,
                u.nome,
                u.email,
                p.name AS parish_name,
                s.name AS system_name,
                ua.role_name
         FROM users u
         LEFT JOIN parishes p ON p.id = u.parish_id
         LEFT JOIN user_access ua ON ua.user_id = u.id AND ua.active = 1
         LEFT JOIN systems s ON s.id = ua.system_id
         WHERE LOWER(u.email) = ?
         ORDER BY ua.id ASC
         LIMIT 1`,
        [loginEmail]
    );

    if (!rows.length) return null;
    return rows[0];
}

async function findExistingCentralUserByEmail(connection, email) {
    const loginEmail = String(email || '').trim().toLowerCase();
    if (!loginEmail) return null;

    const [rows] = await connection.query(
        `SELECT id, parish_id, legacy_user_id, nome, email, active
         FROM users
         WHERE LOWER(email) = ?
         LIMIT 1`,
        [loginEmail]
    );

    if (!rows.length) return null;
    return rows[0];
}

// Helper para hash de senha (simples SHA-256)
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

async function upsertLegacyUser(connection, { tenantId, username, nomeCompleto, senha, grupo, jovemId }) {
    const login = String(username || '').trim().toLowerCase();
    const nome = String(nomeCompleto || '').trim();
    const grupoFinal = String(grupo || 'Jovens').trim() || 'Jovens';
    const jovemIdNum = Number(jovemId);
    const jovemIdFinal = Number.isInteger(jovemIdNum) && jovemIdNum > 0 ? jovemIdNum : null;

    const [rows] = await connection.query(
        'SELECT id FROM db_semeajovens.usuarios WHERE tenant_id = ? AND username = ? LIMIT 1',
        [tenantId, login]
    );

    if (rows.length) {
        await connection.query(
            `UPDATE db_semeajovens.usuarios
             SET nome_completo = ?, senha = ?, grupo = ?, jovem_id = ?
             WHERE id = ?`,
            [nome, hashPassword(senha), grupoFinal, jovemIdFinal, rows[0].id]
        );
        return Number(rows[0].id);
    }

    const [insertResult] = await connection.query(
        `INSERT INTO db_semeajovens.usuarios
         (tenant_id, username, nome_completo, senha, grupo, jovem_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [tenantId, login, nome, hashPassword(senha), grupoFinal, jovemIdFinal]
    );
    return Number(insertResult.insertId);
}

// Listar Usuários
router.get('/', async (req, res) => {
    try {
        await purgeExpiredUsers();
        const { parishId, systemId } = await getCoreContext();
        const tenantId = getTenantId(req);
        const [rows] = await corePool.query(`
            SELECT
                u.id,
                u.nome AS nome_completo,
                u.email AS username,
                NULL AS data_entrada,
                NULL AS data_saida,
                ua.role_name AS grupo,
                NULL AS jovem_id,
                (u.active = 1 AND ua.active = 1) AS ativo,
                lu.tenant_id AS legacy_tenant_id
            FROM user_access ua
            INNER JOIN users u ON u.id = ua.user_id
            LEFT JOIN db_semeajovens.usuarios lu
              ON lu.id = u.legacy_user_id
            WHERE ua.parish_id = ? AND ua.system_id = ?
            ORDER BY u.nome
        `, [parishId, systemId]);

        let managedEmails = new Set();
        let parishManagedRows = [];
        if (tenantId) {
            const [managedRows] = await pool.query(
                `SELECT id, module_code, nome_completo, email, grupo, ativo, created_at, updated_at, LOWER(email) AS email_normalizado
                 FROM tenant_module_users
                 WHERE tenant_id = ?
                   AND module_code = 'semear-jovens'
                   AND ativo = 1`,
                [tenantId]
            );
            parishManagedRows = Array.isArray(managedRows) ? managedRows : [];
            managedEmails = new Set(
                parishManagedRows
                    .map((r) => String(r.email_normalizado || r.email || '').trim().toLowerCase())
                    .filter(Boolean)
            );
        }

        const result = rows.map((row) => {
            const loginEmail = String(row.username || '').trim().toLowerCase();
            const managedByParishAdmin = managedEmails.has(loginEmail);
            return {
                ...row,
                funcoes_dirigencia_ids: [],
                managed_by_parish_admin: managedByParishAdmin
            };
        }).filter((row) => {
            const legacyTenantId = Number(row.legacy_tenant_id || 0);
            if (tenantId && legacyTenantId && legacyTenantId !== Number(tenantId)) return false;
            if (tenantId && !legacyTenantId) return false;
            return true;
        }).map((row) => {
            const { legacy_tenant_id, ...rest } = row;
            return rest;
        });

        const emailsPresentes = new Set(
            result
                .map((row) => String(row.username || '').trim().toLowerCase())
                .filter(Boolean)
        );

        const parishOnlyUsers = parishManagedRows
            .filter((row) => {
                const email = String(row.email || '').trim().toLowerCase();
                return email && !emailsPresentes.has(email);
            })
            .map((row) => ({
                id: `parish-admin-${row.id}`,
                nome_completo: row.nome_completo || 'Usuário do módulo EJC',
                username: row.email || '',
                data_entrada: row.created_at || null,
                data_saida: null,
                grupo: row.grupo || 'Tios',
                jovem_id: null,
                ativo: Number(row.ativo) === 1,
                funcoes_dirigencia_ids: [],
                managed_by_parish_admin: true
            }));

        return res.json([...result, ...parishOnlyUsers]);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Erro ao listar usuários (semear_core)." });
    }
});

// Criar Usuário
router.post('/', async (req, res) => {
    let { username, nome_completo, senha, data_entrada, data_saida, grupo, jovem_id } = req.body;
    void data_entrada;
    void data_saida;

    // Se jovem_id for fornecido, usa nome e e-mail do jovem como login
    const jovemIdNum = Number(jovem_id);
    if (Number.isInteger(jovemIdNum) && jovemIdNum > 0) {
        try {
            const [jovensRes] = await pool.query('SELECT nome_completo, email FROM jovens WHERE id = ?', [jovemIdNum]);
            if (jovensRes.length > 0) {
                nome_completo = jovensRes[0].nome_completo;
                const email = String(jovensRes[0].email || '').trim();
                if (!email) {
                    return res.status(400).json({ error: "Não é possível criar usuário: jovem sem e-mail cadastrado." });
                }
                username = email;
            } else {
                return res.status(400).json({ error: "Jovem não encontrado" });
            }
        } catch (err) {
            console.error(err);
            return res.status(500).json({ error: "Erro ao buscar jovem" });
        }
    }

    if (!username || !nome_completo || !senha || !grupo) {
        return res.status(400).json({ error: "Campos obrigatórios faltando" });
    }

    const connection = await corePool.getConnection();
    try {
        const { parishId, systemId } = await getCoreContext();
        const tenantId = getTenantId(req);
        await connection.beginTransaction();

        const hashedPassword = hashPassword(senha);
        const loginEmail = String(username).trim().toLowerCase();
        const nome = String(nome_completo).trim();
        const legacyUserId = await upsertLegacyUser(connection, {
            tenantId,
            username: loginEmail,
            nomeCompleto: nome,
            senha,
            grupo,
            jovemId: Number.isInteger(jovemIdNum) && jovemIdNum > 0 ? jovemIdNum : null
        });

        const existingCentralUser = await findExistingCentralUserByEmail(connection, loginEmail);
        let userId;

        if (existingCentralUser && Number(existingCentralUser.id) > 0) {
            if (Number(existingCentralUser.parish_id || 0) !== Number(parishId)) {
                await connection.rollback();
                const existente = await findExistingCentralLogin(connection, loginEmail).catch(() => null);
                if (existente) {
                    return res.status(400).json({
                        error: `Este login já existe no sistema central para ${existente.nome || 'outro usuário'}${existente.parish_name ? `, vinculado a ${existente.parish_name}` : ''}${existente.system_name ? ` no sistema ${existente.system_name}` : ''}${existente.role_name ? ` (${existente.role_name})` : ''}.`
                    });
                }
                return res.status(400).json({ error: "Este login já existe no sistema central. Peça ao EJC para falar com a administradora pelo menu Ajuda." });
            }

            userId = Number(existingCentralUser.id);
            await connection.query(
                `UPDATE users
                 SET legacy_source = ?,
                     legacy_user_id = ?,
                     parish_id = ?,
                     nome = ?,
                     email = ?,
                     password_hash_legacy = ?,
                     active = 1
                 WHERE id = ?`,
                [
                    CORE_LEGACY_SOURCE,
                    legacyUserId,
                    parishId,
                    nome,
                    loginEmail,
                    hashedPassword,
                    userId
                ]
            );

            const [accessRows] = await connection.query(
                `SELECT id
                 FROM user_access
                 WHERE user_id = ? AND parish_id = ? AND system_id = ?
                 LIMIT 1`,
                [userId, parishId, systemId]
            );

            if (accessRows.length) {
                await connection.query(
                    `UPDATE user_access
                     SET role_name = ?, active = 1
                     WHERE id = ?`,
                    [String(grupo).trim(), accessRows[0].id]
                );
            } else {
                await connection.query(
                    `INSERT INTO user_access (user_id, parish_id, system_id, role_name, active)
                     VALUES (?, ?, ?, ?, 1)`,
                    [userId, parishId, systemId, String(grupo).trim()]
                );
            }
        } else {
            const [userResult] = await connection.query(
                `INSERT INTO users (legacy_source, legacy_user_id, parish_id, nome, email, password_hash_legacy, active)
                 VALUES (?, ?, ?, ?, ?, ?, 1)`,
                [
                    CORE_LEGACY_SOURCE,
                    legacyUserId,
                    parishId,
                    nome,
                    loginEmail,
                    hashedPassword
                ]
            );

            userId = Number(userResult.insertId);
            await connection.query(
                `INSERT INTO user_access (user_id, parish_id, system_id, role_name, active)
                 VALUES (?, ?, ?, ?, 1)`,
                [userId, parishId, systemId, String(grupo).trim()]
            );
        }

        await connection.commit();
        return res.json({ id: userId, message: "Usuário criado no semear_core com sucesso" });
    } catch (err) {
        await connection.rollback();
        console.error(err);
        if (err.code === 'ER_DUP_ENTRY') {
            const existente = await findExistingCentralLogin(connection, username).catch(() => null);
            if (existente) {
                return res.status(400).json({
                    error: `Este login já existe no sistema central para ${existente.nome || 'outro usuário'}${existente.parish_name ? `, vinculado a ${existente.parish_name}` : ''}${existente.system_name ? ` no sistema ${existente.system_name}` : ''}${existente.role_name ? ` (${existente.role_name})` : ''}.`
                });
            }
            return res.status(400).json({ error: "Este login já existe no sistema central. Peça ao EJC para falar com a administradora pelo menu Ajuda." });
        }
        return res.status(500).json({ error: "Erro ao criar usuário no semear_core." });
    } finally {
        connection.release();
    }
});

// Atualizar Usuário
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { username, nome_completo, senha, data_entrada, data_saida, grupo } = req.body;
    void data_entrada;
    void data_saida;

    if (!username || !nome_completo || !grupo) {
        return res.status(400).json({ error: "Campos obrigatórios faltando" });
    }

    const connection = await corePool.getConnection();
    try {
        const { parishId, systemId } = await getCoreContext();
        const tenantId = getTenantId(req);
        const userId = Number(id);
        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({ error: "ID de usuário inválido." });
        }

        const [checkRows] = await connection.query(
            `SELECT u.id
             FROM users u
             INNER JOIN user_access ua ON ua.user_id = u.id
             WHERE u.id = ? AND ua.parish_id = ? AND ua.system_id = ?
             LIMIT 1`,
            [userId, parishId, systemId]
        );
        if (!checkRows.length) return res.status(404).json({ error: "Usuário não encontrado neste módulo." });

        const [[userEmailRow]] = await connection.query(
            'SELECT email FROM users WHERE id = ? LIMIT 1',
            [userId]
        );
        const currentEmail = String(userEmailRow && userEmailRow.email ? userEmailRow.email : '').trim().toLowerCase();
        if (await isManagedByParishAdmin(tenantId, currentEmail)) {
            return res.status(403).json({ error: "Este usuário é gerenciado pelo painel da paróquia (admin.semearparoquial)." });
        }

        await connection.beginTransaction();

        const [[coreUser]] = await connection.query(
            'SELECT legacy_user_id FROM users WHERE id = ? LIMIT 1',
            [userId]
        );

        let query = 'UPDATE users SET email = ?, nome = ?';
        const params = [String(username).trim().toLowerCase(), String(nome_completo).trim()];

        if (senha) {
            query += ', password_hash_legacy = ?';
            params.push(hashPassword(senha));
        }

        query += ' WHERE id = ?';
        params.push(userId);
        await connection.query(query, params);

        await connection.query(
            `UPDATE user_access
             SET role_name = ?
             WHERE user_id = ? AND parish_id = ? AND system_id = ?`,
            [String(grupo).trim(), userId, parishId, systemId]
        );

        const loginEmail = String(username).trim().toLowerCase();
        const nome = String(nome_completo).trim();
        const grupoFinal = String(grupo || 'Jovens').trim() || 'Jovens';
        const legacyUserId = Number(coreUser && coreUser.legacy_user_id ? coreUser.legacy_user_id : 0);
        if (legacyUserId > 0) {
            if (senha) {
                await connection.query(
                    `UPDATE db_semeajovens.usuarios
                     SET username = ?, nome_completo = ?, senha = ?, grupo = ?
                     WHERE id = ? AND tenant_id = ?`,
                    [loginEmail, nome, hashPassword(senha), grupoFinal, legacyUserId, tenantId]
                );
            } else {
                await connection.query(
                    `UPDATE db_semeajovens.usuarios
                     SET username = ?, nome_completo = ?, grupo = ?
                     WHERE id = ? AND tenant_id = ?`,
                    [loginEmail, nome, grupoFinal, legacyUserId, tenantId]
                );
            }
        }

        await connection.commit();
        return res.json({ message: "Usuário atualizado no semear_core com sucesso" });
    } catch (err) {
        await connection.rollback();
        console.error(err);
        if (err.code === 'ER_DUP_ENTRY') {
            const existente = await findExistingCentralLogin(connection, username).catch(() => null);
            if (existente) {
                return res.status(400).json({
                    error: `Este login já existe no sistema central para ${existente.nome || 'outro usuário'}${existente.parish_name ? `, vinculado a ${existente.parish_name}` : ''}${existente.system_name ? ` no sistema ${existente.system_name}` : ''}${existente.role_name ? ` (${existente.role_name})` : ''}.`
                });
            }
            return res.status(400).json({ error: "Este login já existe no sistema central. Peça ao EJC para falar com a administradora pelo menu Ajuda." });
        }
        return res.status(500).json({ error: "Erro ao atualizar usuário no semear_core." });
    } finally {
        connection.release();
    }
});

// Deletar Usuário
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const { parishId, systemId } = await getCoreContext();
        const tenantId = getTenantId(req);
        const userId = Number(id);
        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({ error: "ID de usuário inválido." });
        }

        const [[userRow]] = await corePool.query('SELECT email FROM users WHERE id = ? LIMIT 1', [userId]);
        const email = String(userRow && userRow.email ? userRow.email : '').trim().toLowerCase();
        if (await isManagedByParishAdmin(tenantId, email)) {
            return res.status(403).json({ error: "Este usuário é gerenciado pelo painel da paróquia (admin.semearparoquial)." });
        }

        const [result] = await corePool.query(
            `DELETE FROM user_access
             WHERE user_id = ? AND parish_id = ? AND system_id = ?`,
            [userId, parishId, systemId]
        );
        if (!result.affectedRows) {
            return res.status(404).json({ error: "Usuário não encontrado neste módulo." });
        }
        return res.json({ message: "Acesso do usuário removido do EJC." });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Erro ao deletar usuário no semear_core." });
    }
});

module.exports = router;
