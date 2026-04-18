const menuTemplate = `
<div id="layout-wrapper">
    <div id="sidebarOverlay"></div>
    <nav id="sidebar">
        <div class="logo-box">
            <img src="/assets/logo-oficial.png" alt="Semear Paroquial" class="brand-mark">
            <div class="brand-stack">
                <span class="brand-name">SEMEAR</span>
                <span class="brand-subtitle">CATEQUESE</span>
            </div>
        </div>

        <div class="nav flex-column mt-2">
            <a href="/dashboard" class="nav-link" data-route="/dashboard">
                <span class="fs-5">📊</span> <span>Dashboard</span>
            </a>
            <a href="/usuarios" class="nav-link" data-route="/usuarios">
                <span class="fs-5">👥</span> <span>Usuários</span>
            </a>
        </div>
    </nav>

    <div id="main-content">
        <header id="page-topbar">
            <div class="d-flex w-100 justify-content-between align-items-center">
                <button id="sidebarToggle" class="btn btn-sm btn-outline-secondary">☰</button>
                <div class="d-flex align-items-center gap-2">
                    <div class="text-muted small">
                        Catequese Infantil
                    </div>
                    <button id="btnLogoutSistema" type="button" class="btn btn-sm btn-outline-danger">
                        Sair
                    </button>
                </div>
            </div>
        </header>

        <div class="page-content" id="PAGE_CONTENT_PLACEHOLDER"></div>
    </div>
</div>
`;

function injetarMenu(rootSelector) {
    const root = document.querySelector(rootSelector);
    if (!root) return;

    const originalContent = root.innerHTML;
    root.innerHTML = menuTemplate;

    const pageContent = root.querySelector('#PAGE_CONTENT_PLACEHOLDER');
    if (pageContent) pageContent.innerHTML = originalContent;

    const layoutWrapper = root.querySelector('#layout-wrapper');
    const toggle = root.querySelector('#sidebarToggle');
    const overlay = root.querySelector('#sidebarOverlay');

    if (toggle && layoutWrapper) {
        toggle.addEventListener('click', () => {
            layoutWrapper.classList.toggle('mobile-open');
        });
    }

    if (overlay && layoutWrapper) {
        overlay.addEventListener('click', () => layoutWrapper.classList.remove('mobile-open'));
    }

    const logoutButton = root.querySelector('#btnLogoutSistema');
    if (logoutButton) {
        logoutButton.addEventListener('click', async () => {
            const afterLoginUrl = `${window.location.origin}/dashboard`;
            try {
                await fetch('http://login.semearparoquial.com.br/api/auth/logout', {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' }
                });
            } catch (_) {
                // Ignora falha de rede e aplica fallback local
            }

            // Fallback para limpeza local da sessão compartilhada
            document.cookie = 'sj_session=; Max-Age=0; path=/; domain=.semearparoquial.com.br';
            window.location.href = `http://login.semearparoquial.com.br/login?next=${encodeURIComponent(afterLoginUrl)}`;
        });
    }
}

function ativarMenu(pathname) {
    const links = document.querySelectorAll('.nav-link[data-route]');
    links.forEach((link) => {
        const route = link.getAttribute('data-route');
        if (route === pathname) link.classList.add('active');
        else link.classList.remove('active');
    });
}

window.injetarMenu = injetarMenu;
window.ativarMenu = ativarMenu;
