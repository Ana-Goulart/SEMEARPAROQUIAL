const { pool } = require('../database');

const MENU_ACCESS_LEVELS = {
    view: 1,
    edit: 2
};

const MENU_ACCESS_OPTIONS = [
    { key: 'gerencia', label: 'Gerencia' },
    { key: 'encontros', label: 'Encontros' },
    { key: 'outros-ejcs', label: 'Outros EJCs' },
    { key: 'planejamento', label: 'Planejamento' },
    { key: 'secretaria', label: 'Secretaria' },
    { key: 'financeiro', label: 'Financeiro' },
    { key: 'minha-igreja', label: 'Minha Igreja' }
];

const VALID_MENU_KEYS = new Set(MENU_ACCESS_OPTIONS.map((item) => item.key));
const VALID_ACCESS_LEVELS = new Set(Object.keys(MENU_ACCESS_LEVELS));

const VIEW_PREFIXES = [
    { key: 'gerencia', prefixes: ['/gestaodoencontro/listamestre', '/gestaodoencontro/tios', '/tios', '/gestaodoencontro/formularios-atualizacao', '/gestaodoencontro/missaoexterna', '/gestaodoencontro/moita', '/gestaodoencontro/garcons', '/garcons', '/moita', '/configuracoes/coordenacoes', '/coordenadores', '/configuracoes/circulos', '/configuracoes/meuejc', '/meu-ejc'] },
    { key: 'encontros', prefixes: ['/gestaodoencontro/equipes', '/equipes', '/gestaodoencontro/ejc', '/historico-equipes', '/ejc/detalhes', '/historico-equipes/detalhes', '/gestaodoencontro/ejc/detalhes', '/gestaodoencontro/montarencontro', '/montar-encontro', '/gestaodoencontro/votacao', '/votacao'] },
    { key: 'outros-ejcs', prefixes: ['/gestaodoencontro/outrosejcs', '/gestaodoencontro/jovensoutroejc', '/outros-ejcs'] },
    { key: 'planejamento', prefixes: ['/planejamento/calendario', '/calendario', '/planejamento/eventos', '/eventos', '/planejamento/inscricoes', '/inscricoes'] },
    { key: 'secretaria', prefixes: ['/planejamento/atasdereuniao', '/ata-reunioes'] },
    { key: 'financeiro', prefixes: ['/administrativo/financeiro', '/financeiro'] },
    { key: 'minha-igreja', prefixes: ['/administrativo/contatos', '/contatos', '/planejamento/espacos', '/administrativo/almoxarifado'] }
];

const API_PREFIXES = [
    { key: 'gerencia', prefixes: ['/lista-mestre', '/historico', '/jovens', '/jovem', '/importacao', '/tios', '/coordenadores', '/garcons', '/moita', '/meu-ejc', '/circulos', '/atualizacoes-cadastro'] },
    { key: 'encontros', prefixes: ['/ejc', '/equipes', '/historico-equipes', '/montar-encontro', '/votacao', '/ejcs', '/todas-equipes', '/equipes-ejc'] },
    { key: 'outros-ejcs', prefixes: ['/outros-ejcs'] },
    { key: 'planejamento', prefixes: ['/formularios'] },
    { key: 'secretaria', prefixes: ['/ata-reunioes'] },
    { key: 'financeiro', prefixes: ['/financeiro'] },
    { key: 'minha-igreja', prefixes: ['/contatos', '/pastorais', '/almoxarifado'] }
];

function normalizarAcessoMenus(value) {
    const raw = Array.isArray(value) ? value : [];
    const result = [];
    const seen = new Set();

    for (const item of raw) {
        const key = String(item && item.menu_key || item && item.key || '').trim();
        const accessLevel = String(item && item.access_level || item && item.nivel || '').trim();
        if (!VALID_MENU_KEYS.has(key) || !VALID_ACCESS_LEVELS.has(accessLevel) || seen.has(key)) continue;
        seen.add(key);
        result.push({ menu_key: key, access_level: accessLevel });
    }

    return result;
}

function accessRowsToMap(rows) {
    const access = {};
    for (const item of MENU_ACCESS_OPTIONS) access[item.key] = null;

    for (const row of rows || []) {
        const key = String(row.menu_key || '').trim();
        const level = String(row.access_level || '').trim();
        if (!VALID_MENU_KEYS.has(key) || !VALID_ACCESS_LEVELS.has(level)) continue;
        const atual = access[key];
        if (!atual || MENU_ACCESS_LEVELS[level] > MENU_ACCESS_LEVELS[atual]) {
            access[key] = level;
        }
    }

    return access;
}

async function carregarAcessosUsuario(tenantId, usuarioId) {
    const tenant = Number(tenantId || 0);
    const user = Number(usuarioId || 0);
    if (!tenant || !user) return accessRowsToMap([]);

    const [rows] = await pool.query(
        `SELECT fdm.menu_key, fdm.access_level
         FROM funcoes_dirigencia_menus fdm
         JOIN funcoes_dirigencia_usuarios fdu
           ON fdu.funcao_id = fdm.funcao_id
          AND fdu.tenant_id = fdm.tenant_id
         WHERE fdu.tenant_id = ?
           AND fdu.usuario_id = ?`,
        [tenant, user]
    );
    return accessRowsToMap(rows);
}

function requiredLevelForMethod(method) {
    return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || '').toUpperCase()) ? 'edit' : 'view';
}

function matchPrefix(pathname, config) {
    const path = String(pathname || '').split('?')[0].replace(/\/+$/, '') || '/';
    for (const item of config) {
        if ((item.prefixes || []).some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
            return item.key;
        }
    }
    return null;
}

function hasAccess(accessMap, menuKey, requiredLevel = 'view') {
    if (!menuKey) return true;
    const current = accessMap && accessMap[menuKey];
    if (!current) return false;
    return MENU_ACCESS_LEVELS[current] >= MENU_ACCESS_LEVELS[requiredLevel];
}

function requireMenuViewAccess(menuKey) {
    return async (req, res, next) => {
        try {
            const access = await carregarAcessosUsuario(req.user && req.user.tenant_id, req.user && req.user.id);
            if (hasAccess(access, menuKey, 'view')) return next();
            return res.redirect('/dashboard');
        } catch (err) {
            console.error('Erro ao validar acesso ao menu:', err);
            return res.redirect('/dashboard');
        }
    };
}

async function menuAccessApiMiddleware(req, res, next) {
    const path = String(req.path || '');
    if (path.startsWith('/auth') || path === '/ping') return next();

    const menuKey = matchPrefix(path, API_PREFIXES);
    if (!menuKey) return next();

    try {
        const access = await carregarAcessosUsuario(req.user && req.user.tenant_id, req.user && req.user.id);
        const requiredLevel = requiredLevelForMethod(req.method);
        if (requiredLevel === 'view') return next();
        if (hasAccess(access, menuKey, requiredLevel)) return next();
        return res.status(403).json({
            error: 'Seu acesso a este menu permite apenas visualizacao.'
        });
    } catch (err) {
        console.error('Erro ao validar acesso de API:', err);
        return res.status(500).json({ error: 'Erro ao validar permissoes.' });
    }
}

module.exports = {
    MENU_ACCESS_OPTIONS,
    VALID_MENU_KEYS,
    VALID_ACCESS_LEVELS,
    normalizarAcessoMenus,
    carregarAcessosUsuario,
    requireMenuViewAccess,
    menuAccessApiMiddleware
};
