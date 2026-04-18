const { pool } = require('../database');
const { ensureTenantStructure } = require('./tenantSetup');

const SYSTEM_CODE = 'semear-jovens';
const MENU_BY_PREFIX = [
    ['/api/lista-mestre', 'Cadastro de Jovens'],
    ['/api/jovens', 'Cadastro de Jovens'],
    ['/api/jovem', 'Cadastro de Jovens'],
    ['/api/historico', 'Cadastro de Jovens'],
    ['/api/tios', 'Tios'],
    ['/api/equipes', 'Equipes e Funções'],
    ['/api/ejc', 'Edições do EJC'],
    ['/api/montar-encontro', 'Montagem do Encontro'],
    ['/api/regras-ejc', 'Regras'],
    ['/api/formularios', 'Formulários'],
    ['/api/votacao', 'Votação'],
    ['/api/outros-ejcs', 'Outros EJCs'],
    ['/api/visitantes', 'Visitantes'],
    ['/api/moita', 'Moita'],
    ['/api/garcons', 'Garçons'],
    ['/api/financeiro', 'Financeiro'],
    ['/api/anexos', 'Anexos'],
    ['/api/contatos', 'Contatos'],
    ['/api/almoxarifado', 'Almoxarifado'],
    ['/api/usuarios', 'Usuários'],
    ['/api/coordenadores', 'Coordenações'],
    ['/api/funcoes-dirigencia', 'Funções da Dirigência'],
    ['/api/meu-ejc', 'Meu EJC'],
    ['/api/circulos', 'Círculos'],
    ['/api/relacoes-familiares', 'Família e Relacionamentos']
];

function getMenuLabel(pathname) {
    const found = MENU_BY_PREFIX.find(([prefix]) => pathname.startsWith(prefix));
    return found ? found[1] : 'Sistema';
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
        body.nome,
        body.cor,
        body.descricao,
        body.titulo,
        body.assunto,
        body.email,
        body.username
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
    if (!req.user || !req.user.id || !req.user.tenant_id) return null;
    const [rows] = await pool.query(
        `SELECT id, tenant_id, username, nome_completo
         FROM usuarios
         WHERE id = ? AND tenant_id = ?
         LIMIT 1`,
        [req.user.id, req.user.tenant_id]
    );
    if (!rows.length) return null;
    return {
        actorType: 'TENANT_USER',
        actorUserId: Number(rows[0].id),
        actorIdentifier: rows[0].username || '',
        actorName: rows[0].nome_completo || '',
        tenantId: Number(rows[0].tenant_id)
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
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                SYSTEM_CODE,
                actor.tenantId,
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
        console.error('Erro ao gravar log de atividade do SemearJovens:', err);
    }
}

function activityLoggerMiddleware(req, res, next) {
    const method = String(req.method || '').toUpperCase();
    const pathname = String(req.path || '');
    const shouldLog = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
        && !pathname.startsWith('/api/auth')
        && !pathname.startsWith('/api/logs');
    if (!shouldLog) return next();

    res.on('finish', () => {
        if (res.statusCode >= 200 && res.statusCode < 400) writeLog(req);
    });
    next();
}

async function listLogs(tenantId) {
    await ensureTenantStructure();
    await purgeOldLogs();
    const [rows] = await pool.query(
        `SELECT id, actor_identifier, actor_name, menu_label, action_label, created_at
         FROM system_activity_logs
         WHERE system_code = ?
           AND tenant_id = ?
           AND created_at >= (NOW() - INTERVAL 2 MONTH)
         ORDER BY created_at DESC
         LIMIT 500`,
        [SYSTEM_CODE, tenantId]
    );
    return rows;
}

module.exports = {
    activityLoggerMiddleware,
    listLogs
};
