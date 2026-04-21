const express = require('express');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });
const app = express();
const { attachUserFromSession, clearSessionCookie } = require('./lib/authSession');
const { attachAdminFromSession } = require('./lib/adminSession');
const { pool } = require('./database');
const { purgeExpiredUsers } = require('./lib/usuariosExpiracao');
const { ensureTenantStructure } = require('./lib/tenantSetup');
const { ensureTenantIsolation } = require('./lib/tenantIsolation');
const rotasEJC = require('./routes/ejc');
const rotasListaMestre = require('./routes/listaMestre');
const rotasEquipes = require('./routes/equipes');
const rotasAnexos = require('./routes/anexos');
const rotasUsuarios = require('./routes/usuarios');
const rotasHistoricoEquipes = require('./routes/historicoEquipes');
const rotasVotacao = require('./routes/votacao');
const rotasOutrosEjcs = require('./routes/outrosEjcs');
const rotasMontarEncontro = require('./routes/montar-encontro');
const rotasFinanceiro = require('./routes/financeiro');
const rotasCoordenadores = require('./routes/coordenadores');
const rotasGarcons = require('./routes/garcons');
const rotasMoita = require('./routes/moita');
const rotasAtaReunioes = require('./routes/ataReunioes');
const rotasFuncoesDirigencia = require('./routes/funcoesDirigencia');
const rotasFormularios = require('./routes/formularios');
const rotasFormulariosPublic = require('./routes/formulariosPublic');
const rotasVisitantes = require('./routes/visitantes');
const rotasContatos = require('./routes/contatos');
const rotasPastorais = require('./routes/pastorais');
const rotasTios = require('./routes/tios');
const rotasCep = require('./routes/cep');
const rotasJovensPublic = require('./routes/jovensPublic');
const rotasTiosPublic = require('./routes/tiosPublic');
const rotasJovensOutroEjcPublic = require('./routes/jovensOutroEjcPublic');
const rotasAtualizacoesCadastro = require('./routes/atualizacoesCadastro');
const rotasAuth = require('./routes/auth');
const rotasMeuEjc = require('./routes/meuEjc');
const rotasCirculos = require('./routes/circulos');
const rotasUsoSistema = require('./routes/usoSistema');
const rotasBackup = require('./routes/backup');
const rotasAlmoxarifado = require('./routes/almoxarifado');
const rotasDashboard = require('./routes/dashboard');
const rotasAjuda = require('./routes/ajuda');
const rotasRelacoesFamiliares = require('./routes/relacoesFamiliares');
const rotasLogs = require('./routes/logs');
const { activityLoggerMiddleware } = require('./lib/activityLogs');
const { personNameResponseMiddleware } = require('./lib/personNameFormatting');

const CORE_LOGIN_URL = String(process.env.CORE_LOGIN_URL || 'https://login.semearparoquial.com.br/login').trim();
const SEMEAR_JOVENS_DASHBOARD_URL = String(process.env.SEMEAR_JOVENS_DASHBOARD_URL || 'https://ejc.semearparoquial.com.br:3003/dashboard').trim();
const PARISH_ADMIN_URL = String(process.env.PARISH_ADMIN_URL || 'https://admin.semearparoquial.com.br:3001').trim().replace(/\/+$/, '');
const ADMIN_HOSTNAME = String(process.env.ADMIN_HOSTNAME || 'admin.semearparoquial.com.br').trim().toLowerCase();

function buildCoreLoginRedirect() {
    const next = encodeURIComponent(SEMEAR_JOVENS_DASHBOARD_URL);
    const hasQuery = CORE_LOGIN_URL.includes('?');
    return `${CORE_LOGIN_URL}${hasQuery ? '&' : '?'}next=${next}`;
}

function getRequestHostname(req) {
    return String(req.hostname || '').trim().toLowerCase();
}

function isAdminHost(req) {
    const host = getRequestHostname(req);
    return !!(host && host === ADMIN_HOSTNAME);
}

app.use(express.json());
app.use(personNameResponseMiddleware);
app.use(attachUserFromSession);
app.use(attachAdminFromSession);
app.use(express.static(path.join(__dirname, 'public'))); // Serve arquivos estáticos
app.get('/favicon.ico', (_req, res) => res.redirect('/assets/logo-oficial.png'));
app.use((req, res, next) => {
    if (!isAdminHost(req)) return next();
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'APIs de admin da paróquia migradas para o serviço SemearAdmin.' });
    }
    const targetPath = req.path === '/' ? '/login' : req.path;
    return res.redirect(`${PARISH_ADMIN_URL}${targetPath}`);
});

async function requireLoginView(req, res, next) {
    if (!req.user || !req.user.id) return res.redirect('/login');
    try {
        await purgeExpiredUsers();
        await ensureTenantStructure();
        await ensureTenantIsolation();
        const [rows] = await pool.query('SELECT id, tenant_id FROM usuarios WHERE id = ? LIMIT 1', [req.user.id]);
        if (!rows.length) {
            clearSessionCookie(res);
            return res.redirect('/login');
        }
        req.user = { id: rows[0].id, tenant_id: rows[0].tenant_id || null };
    } catch (err) {
        console.error('Erro ao validar sessão de view:', err);
        clearSessionCookie(res);
        return res.redirect('/login');
    }
    next();
}

async function requireLoginApi(req, res, next) {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'Não autenticado.' });
    try {
        await purgeExpiredUsers();
        await ensureTenantStructure();
        await ensureTenantIsolation();
        const [rows] = await pool.query('SELECT id, tenant_id FROM usuarios WHERE id = ? LIMIT 1', [req.user.id]);
        if (!rows.length) {
            clearSessionCookie(res);
            return res.status(401).json({ error: 'Sessão expirada.' });
        }
        req.user = { id: rows[0].id, tenant_id: rows[0].tenant_id || null };
    } catch (err) {
        console.error('Erro ao validar sessão de API:', err);
        clearSessionCookie(res);
        return res.status(401).json({ error: 'Sessão inválida.' });
    }
    next();
}

// Alias direto para finalizar encontro (garante a rota mesmo com mounts antigos)
app.post('/api/montar-encontro/:id/finalizar', requireLoginApi, (req, res, next) => {
    if (typeof rotasMontarEncontro.finalizarEncontroHandler === 'function') {
        return rotasMontarEncontro.finalizarEncontroHandler(req, res, next);
    }
    return res.status(404).json({ error: 'Rota de finalização indisponível.' });
});

app.get('/api/ping', requireLoginApi, (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
});

// --- VIEW ROUTES ---
app.get('/login', (req, res) => {
    if (req.user && req.user.id) return res.redirect('/dashboard');
    return res.redirect(buildCoreLoginRedirect());
});
app.get('/admin/login', (_req, res) => res.redirect(`${PARISH_ADMIN_URL}/login`));
app.get('/admin', (_req, res) => res.redirect(`${PARISH_ADMIN_URL}/painel`));
app.get('/formularios/public/:token', (req, res) => res.sendFile(path.join(__dirname, 'views', 'formulario-publico.html')));
app.get('/eventos/public/:token', (req, res) => res.sendFile(path.join(__dirname, 'views', 'formulario-publico.html')));
app.get('/inscricoes/public/:token', (req, res) => res.sendFile(path.join(__dirname, 'views', 'formulario-publico.html')));
app.get('/jovens/atualizar-cadastro', (_req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    return res.sendFile(path.join(__dirname, 'views', 'jovens-atualizar.html'));
});
app.get('/jovens/criar-cadastro', (_req, res) => res.sendFile(path.join(__dirname, 'views', 'jovens-criar.html')));
app.get('/jovens/atualizar-cadastro/obrigado', (_req, res) => res.sendFile(path.join(__dirname, 'views', 'jovens-atualizar-obrigado.html')));
app.get('/tios/atualizar-telefone', (_req, res) => res.sendFile(path.join(__dirname, 'views', 'tios-atualizar.html')));
app.get('/jovens-outro-ejc/atualizar-cadastro', (_req, res) => res.sendFile(path.join(__dirname, 'views', 'jovens-outro-ejc-atualizar.html')));
app.get('/', (req, res) => {
    if (req.user && req.user.id) return res.redirect('/dashboard');
    return res.redirect('/dashboard');
});
app.get('/dashboard', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));
app.get('/ejc', (req, res) => res.redirect('/historico-equipes'));
app.get('/equipes', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'equipes.html')));
app.get('/historico-equipes', requireLoginView, (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    return res.sendFile(path.join(__dirname, 'views', 'historico-equipes.html'));
});
app.get('/anexos', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'anexos.html')));
app.get('/usuarios', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'usuarios.html')));
app.get('/votacao', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'votacao.html')));
app.get('/outros-ejcs', requireLoginView, (req, res) => {
    const params = new URLSearchParams(req.query || {});
    const query = params.toString();
    return res.redirect(`/gestaodoencontro/outrosejcs${query ? `?${query}` : ''}`);
});
app.get('/montar-encontro', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'montar-encontro.html')));
app.get('/gestaodoencontro/montarencontro/equipe', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'montar-encontro-equipe.html')));
app.get('/financeiro', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'financeiro.html')));
app.get('/coordenadores', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'coordenadores.html')));
app.get('/garcons', requireLoginView, (req, res) => res.redirect('/gestaodoencontro/missaoexterna?aba=garcons'));
app.get('/moita', requireLoginView, (req, res) => res.redirect('/gestaodoencontro/missaoexterna?aba=moitas'));
app.get('/ata-reunioes', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'ata-reunioes.html')));
app.get('/funcoes-dirigencia', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'funcoes-dirigencia.html')));
app.get('/calendario', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'calendario.html')));
app.get('/formularios', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'formularios.html')));
app.get('/eventos', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'formularios.html')));
app.get('/inscricoes', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'formularios.html')));
app.get('/meu-ejc', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'meu-ejc.html')));
app.get('/visitantes', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'visitantes.html')));
app.get('/contatos', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'contatos.html')));
app.get('/tios', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'tios.html')));

// --- ROTAS NOVAS DE NAVEGAÇÃO AGRUPADA ---
app.get('/gestaodoencontro/listamestre', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'listaMestre.html')));
app.get('/gestaodoencontro/equipes', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'equipes.html')));
app.get('/gestaodoencontro/ejc', requireLoginView, (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    return res.sendFile(path.join(__dirname, 'views', 'historico-equipes.html'));
});
app.get(
    [
        '/gestaodoencontro/ejc/detalhes',
        '/historico-equipes/detalhes',
        '/ejc/detalhes'
    ],
    requireLoginView,
    (req, res) => res.sendFile(path.join(__dirname, 'views', 'ejc-detalhes.html'))
);
app.get('/gestaodoencontro/outrosejcs', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'jovens-outro-ejc.html')));
app.get('/gestaodoencontro/jovensoutroejc', requireLoginView, (req, res) => {
    const params = new URLSearchParams(req.query || {});
    params.set('aba', 'membros');
    return res.redirect(`/gestaodoencontro/outrosejcs?${params.toString()}`);
});
app.get('/gestaodoencontro/visitantes', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'visitantes.html')));
app.get('/gestaodoencontro/tios', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'tios.html')));
app.get('/gestaodoencontro/montarencontro', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'montar-encontro.html')));
app.get('/gestaodoencontro/regras', requireLoginView, (_req, res) => res.redirect('/gestaodoencontro/ejc'));
app.get('/gestaodoencontro/missaoexterna', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'missao-externa.html')));
app.get('/gestaodoencontro/moita', requireLoginView, (req, res) => {
    if (String(req.query.embed || '') === '1') {
        return res.sendFile(path.join(__dirname, 'views', 'moita.html'));
    }
    return res.redirect('/gestaodoencontro/missaoexterna?aba=moitas');
});
app.get('/gestaodoencontro/garcons', requireLoginView, (req, res) => {
    if (String(req.query.embed || '') === '1') {
        return res.sendFile(path.join(__dirname, 'views', 'garcons.html'));
    }
    return res.redirect('/gestaodoencontro/missaoexterna?aba=garcons');
});
app.get('/gestaodoencontro/votacao', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'votacao.html')));
app.get('/gestaodoencontro/formularios-atualizacao', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'formularios-atualizacao.html')));

app.get('/planejamento/calendario', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'calendario.html')));
app.get('/planejamento/espacos', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'espacos-igreja.html')));
app.get('/planejamento/eventos', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'formularios.html')));
app.get('/planejamento/inscricoes', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'formularios.html')));
app.get('/planejamento/atasdereuniao', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'ata-reunioes.html')));

app.get('/administrativo/financeiro', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'financeiro.html')));
app.get('/administrativo/anexos', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'anexos.html')));
app.get('/administrativo/contatos', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'contatos.html')));
app.get('/administrativo/uso-sistema', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'uso-sistema.html')));
app.get('/administrativo/backup', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'backup.html')));
app.get('/administrativo/almoxarifado', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'almoxarifado.html')));
app.get('/administrativo/ajuda', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'ajuda.html')));
app.get('/administrativo/logs', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'logs.html')));

app.get('/configuracoes/usuarios', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'usuarios.html')));
app.get('/configuracoes/coordenacoes', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'coordenadores.html')));
app.get('/configuracoes/funcoes-dirigencia', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'funcoes-dirigencia.html')));
app.get('/configuracoes/meuejc', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'meu-ejc.html')));
app.get('/configuracoes/circulos', requireLoginView, (req, res) => res.sendFile(path.join(__dirname, 'views', 'circulos.html')));

// --- API ROUTES ---
app.use('/api/auth', rotasAuth);
app.use('/api/admin', (_req, res) => res.status(410).json({ error: 'APIs movidas para admin.semearparoquial.com.br:3001' }));
app.use('/api/formularios/public', rotasFormulariosPublic);
app.use('/api/jovens-public', rotasJovensPublic);
app.use('/api/tios-public', rotasTiosPublic);
app.use('/api/jovens-outro-ejc-public', rotasJovensOutroEjcPublic);
app.use('/api/cep', rotasCep);
app.use('/api', requireLoginApi);
app.use('/api', activityLoggerMiddleware);
app.use('/api/atualizacoes-cadastro', rotasAtualizacoesCadastro);
app.use('/api/ejc', rotasEJC);
app.use('/api/lista-mestre', rotasListaMestre);
app.use('/api/anexos', rotasAnexos);
app.use('/api/usuarios', rotasUsuarios);
app.use('/api/equipes', rotasEquipes);
app.use('/api/historico-equipes', rotasHistoricoEquipes);
app.use('/api/votacao', rotasVotacao);
app.use('/api/outros-ejcs', rotasOutrosEjcs);
app.use('/api/montar-encontro', rotasMontarEncontro);
app.use('/api/financeiro', rotasFinanceiro);
app.use('/api/coordenadores', rotasCoordenadores);
app.use('/api/garcons', rotasGarcons);
app.use('/api/moita', rotasMoita);
app.use('/api/ata-reunioes', rotasAtaReunioes);
app.use('/api/funcoes-dirigencia', rotasFuncoesDirigencia);
app.use('/api/formularios', rotasFormularios);
app.use('/api/visitantes', rotasVisitantes);
app.use('/api/contatos', rotasContatos);
app.use('/api/pastorais', rotasPastorais);
app.use('/api/tios', rotasTios);
app.use('/api/meu-ejc', rotasMeuEjc);
app.use('/api/circulos', rotasCirculos);
app.use('/api/uso-sistema', rotasUsoSistema);
app.use('/api/backup', rotasBackup);
app.use('/api/almoxarifado', rotasAlmoxarifado);
app.use('/api/dashboard', rotasDashboard);
app.use('/api/ajuda', rotasAjuda);
app.use('/api/relacoes-familiares', rotasRelacoesFamiliares);
app.use('/api/logs', rotasLogs);

// --- ROTAS ANTIGAS / COMPATIBILIDADE ---
// Algumas rotas frontend chamavam URLs específicas que agora estão dentro dos módulos.
// Precisamos garantir que os fronts funcionem.
// Vou mapear as chamadas antigas para os novos controllers se necessário, 
// ou idealmente ajustar o front, mas como o pedido é refatorar backend, vou usar redirecionamentos ou mounts adicionais.

// Lista Mestre Front chama: /api/lista-mestre (ok), /api/historico/:id, /api/importacao, etc.
// O router 'rotasListaMestre' está montado em /api/lista-mestre. 
// ENTÃO: GET /api/lista-mestre/ chama router.get('/').
// MAS: GET /api/historico/:id no front antigo era direto.
// Se eu mudar para /api/lista-mestre/historico/:id, quebra o front.
// PARA NÃO QUEBRAR O FRONT: Vou montar o router em caminhos múltiplos ou criar alias.

// 1. Rota principal da Lista Mestre
// 2. Rotas de Histórico e Jovem eram soltas.
app.use('/api/historico', (req, res, next) => {
    // Redireciona chamadas /api/historico para dentro do rotasListaMestre
    // Mas rotasListaMestre espera /historico/:id
    // Se a req.url for /:id, e eu der use, ele passa /:id.
    // Vamos usar o router diretamente aqui também?
    rotasListaMestre(req, res, next);
});

// Rota de busca jovem e outras do lista mestre
app.use('/api/jovens', rotasListaMestre);
app.use('/api/jovem', (req, res, next) => {
    rotasListaMestre(req, res, next);
});

// Importação
app.post('/api/importacao', (req, res, next) => {
    req.url = '/importacao'; // Ajusta url interna para dar match no router
    rotasListaMestre(req, res, next);
});

// EJCs Dropdown
app.get('/api/ejcs', (req, res, next) => {
    // Chama rotasEJC GET /
    req.url = '/';
    rotasEJC(req, res, next);
});

// Equipes Dropdown e Filtros
app.get('/api/todas-equipes', (req, res, next) => {
    req.url = '/';
    rotasEquipes(req, res, next);
});
app.get('/api/equipes/:ejcId', (req, res, next) => {
    req.url = '/por-ejc/' + req.params.ejcId; // Ajuste para nome da rota no controller
    rotasEquipes(req, res, next);
});
// Rota de DELETE vinculo antigo: /api/equipes-ejc/:ejcId/:equipeId
app.delete('/api/equipes-ejc/:ejcId/:equipeId', (req, res, next) => {
    req.url = '/vinculo/' + req.params.ejcId + '/' + req.params.equipeId;
    rotasEquipes(req, res, next);
});


// Rota antiga de historico-equipes view
// /api/equipes/:equipeId/jovens/:ejcId -> /api/historico-equipes/:equipeId/jovens/:ejcId
app.get('/api/equipes/:equipeId/jovens/:ejcId', (req, res, next) => {
    rotasHistoricoEquipes(req, res, next);
});


const PORT = Number(process.env.PORT || 3003);
app.listen(PORT, () => {
    console.log(`🚀 EJC rodando na porta ${PORT}`);
});
