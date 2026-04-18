const { pool } = require('../database');
const { ensureTenantStructure } = require('./tenantSetup');

const SYSTEM_CODE = 'semear-core';
const MENU_BY_PREFIX = [
    ['/api/admin/tenants', 'Paróquias'],
    ['/api/admin/admin-users', 'Usuários do sistema'],
    ['/api/admin/support-messages', 'Mensagens'],
    ['/api/admin/tenants/', 'Paróquias']
];

function getMenuLabel(pathname) {
    const found = MENU_BY_PREFIX.find(([prefix]) => pathname.startsWith(prefix));
    return found ? found[1] : 'Dashboard';
}

function getActionVerb(method) {
    if (method === 'POST') return 'Criou';
    if (method === 'PUT') return 'Atualizou';
    if (method === 'PATCH') return 'Atualizou';
    if (method === 'DELETE') return 'Removeu';
    return 'Realizou ação em';
}

function extractSubject(body) {
    if (!body || typeof body !== 'object') return '';
    const candidates = [
        body.nome_completo,
        body.username,
        body.paroquia,
        body.nome_ejc,
        body.assunto,
        body.email
    ];
    const found = candidates.find((value) => String(value || '').trim());
    return found ? String(found).trim() : '';
}

function buildActionLabel(method, menuLabel, body) {
    const verb = getActionVerb(method);
    const subject = extractSubject(body);
    if (subject) return `${verb} em ${menuLabel}: ${subject}`;
    return `${verb} um registro em ${menuLabel}`;
}

async function purgeOldLogs() {
    await pool.query(
        `DELETE FROM system_activity_logs
         WHERE system_code = ?
           AND created_at < (NOW() - INTERVAL 2 MONTH)`,
        [SYSTEM_CODE]
    );
}

async function resolveActor(req) {
    if (!req.admin || !req.admin.id) return null;
    const [rows] = await pool.query(
        `SELECT id, username, nome_completo
         FROM admin_usuarios
         WHERE id = ?
         LIMIT 1`,
        [req.admin.id]
    );
    if (!rows.length) return null;
    return {
        actorType: 'SUPER_ADMIN',
        actorUserId: Number(rows[0].id),
        actorIdentifier: rows[0].username || '',
        actorName: rows[0].nome_completo || ''
    };
}

async function writeLog(req) {
    try {
        await ensureTenantStructure();
        await purgeOldLogs();
        const actor = await resolveActor(req);
        if (!actor) return;
        const menuLabel = getMenuLabel(req.originalUrl || req.path || '');
        const actionLabel = buildActionLabel(req.method, menuLabel, req.body);
        await pool.query(
            `INSERT INTO system_activity_logs
             (system_code, tenant_id, actor_type, actor_user_id, actor_identifier, actor_name, menu_label, action_label, http_method, request_path, metadata_json)
             VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                SYSTEM_CODE,
                actor.actorType,
                actor.actorUserId,
                actor.actorIdentifier,
                actor.actorName,
                menuLabel,
                actionLabel,
                req.method,
                req.originalUrl || req.path || '',
                JSON.stringify({ body: req.body || {} })
            ]
        );
    } catch (err) {
        console.error('Erro ao gravar log de atividade do SemearCore:', err);
    }
}

function activityLoggerMiddleware(req, res, next) {
    const method = String(req.method || '').toUpperCase();
    const pathname = String(req.path || '');
    const shouldLog = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
        && !pathname.startsWith('/api/admin/login')
        && !pathname.startsWith('/api/admin/logout')
        && !pathname.startsWith('/api/admin/logs')
        && !pathname.startsWith('/api/auth');
    if (!shouldLog) return next();

    res.on('finish', () => {
        if (res.statusCode >= 200 && res.statusCode < 400) writeLog(req);
    });
    next();
}

async function listLogs() {
    await ensureTenantStructure();
    await purgeOldLogs();
    const [rows] = await pool.query(
        `SELECT id, actor_identifier, actor_name, menu_label, action_label, created_at
         FROM system_activity_logs
         WHERE system_code = ?
           AND created_at >= (NOW() - INTERVAL 2 MONTH)
         ORDER BY created_at DESC
         LIMIT 500`,
        [SYSTEM_CODE]
    );
    return rows;
}

module.exports = {
    activityLoggerMiddleware,
    listLogs
};
