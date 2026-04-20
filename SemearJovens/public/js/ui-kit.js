(() => {
    const nativeAlert = window.alert;
    const nativeConfirm = window.confirm;

    const hasBootstrap = () => window.bootstrap && typeof window.bootstrap.Modal === 'function';

    let modalEl = null;
    let modalInstance = null;
    let resolveFn = null;
    let mode = 'alert';

    const ensureModal = () => {
        if (modalEl) return;
        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
<div class="modal fade" id="uiModalPadrao" tabindex="-1" aria-hidden="true">
  <div class="modal-dialog modal-dialog-centered">
    <div class="modal-content ui-modal">
      <div class="modal-header">
        <h5 class="modal-title" id="uiModalTitulo">Aviso</h5>
        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Fechar"></button>
      </div>
      <div class="modal-body" id="uiModalMensagem"></div>
      <div class="modal-body pt-0 d-none" id="uiModalInputWrap">
        <input type="text" class="form-control" id="uiModalInput" />
      </div>
      <div class="modal-footer" id="uiModalFooter">
        <button type="button" class="btn btn-outline-secondary" data-ui-cancel>Cancelar</button>
        <button type="button" class="btn btn-primary" data-ui-ok>OK</button>
      </div>
    </div>
  </div>
</div>`;
        modalEl = wrapper.firstElementChild;
        document.body.appendChild(modalEl);
        modalInstance = new window.bootstrap.Modal(modalEl);

        const okBtn = modalEl.querySelector('[data-ui-ok]');
        const cancelBtn = modalEl.querySelector('[data-ui-cancel]');

        okBtn.addEventListener('click', () => {
            if (resolveFn) {
                if (mode === 'prompt') {
                    const input = modalEl.querySelector('#uiModalInput');
                    resolveFn(input ? input.value : '');
                } else {
                    resolveFn(true);
                }
            }
            resolveFn = null;
            modalInstance.hide();
        });

        cancelBtn.addEventListener('click', () => {
            if (resolveFn) {
                resolveFn(mode === 'prompt' ? null : false);
            }
            resolveFn = null;
            modalInstance.hide();
        });

        modalEl.addEventListener('hidden.bs.modal', () => {
            if (resolveFn) resolveFn(mode === 'prompt' ? null : false);
            resolveFn = null;
        });

        modalEl.addEventListener('shown.bs.modal', () => {
            if (mode === 'prompt') {
                const input = modalEl.querySelector('#uiModalInput');
                if (input) input.focus();
            }
        });
    };

    const openModal = ({ title, message, confirm, prompt, defaultValue }) => {
        ensureModal();
        const titleEl = modalEl.querySelector('#uiModalTitulo');
        const msgEl = modalEl.querySelector('#uiModalMensagem');
        const footer = modalEl.querySelector('#uiModalFooter');
        const cancelBtn = modalEl.querySelector('[data-ui-cancel]');
        const okBtn = modalEl.querySelector('[data-ui-ok]');
        const inputWrap = modalEl.querySelector('#uiModalInputWrap');
        const input = modalEl.querySelector('#uiModalInput');

        titleEl.textContent = title || 'Aviso';
        msgEl.textContent = message || '';

        mode = prompt ? 'prompt' : (confirm ? 'confirm' : 'alert');

        if (prompt) {
            cancelBtn.classList.remove('d-none');
            okBtn.textContent = 'Confirmar';
            inputWrap.classList.remove('d-none');
            if (input) input.value = defaultValue || '';
        } else if (confirm) {
            cancelBtn.classList.remove('d-none');
            okBtn.textContent = 'Confirmar';
            inputWrap.classList.add('d-none');
        } else {
            cancelBtn.classList.add('d-none');
            okBtn.textContent = 'OK';
            inputWrap.classList.add('d-none');
        }
        footer.classList.toggle('ui-footer-center', !confirm && !prompt);

        modalInstance.show();
        return new Promise((resolve) => {
            resolveFn = resolve;
        });
    };

    window.uiAlert = (message, options = {}) => {
        if (!hasBootstrap()) {
            nativeAlert(message);
            return Promise.resolve(true);
        }
        return openModal({
            title: options.title || 'Aviso',
            message: String(message || ''),
            confirm: false
        });
    };

    window.uiConfirm = (message, options = {}) => {
        if (!hasBootstrap()) return Promise.resolve(nativeConfirm(message));
        return openModal({
            title: options.title || 'Confirmação',
            message: String(message || ''),
            confirm: true
        });
    };

    window.uiPrompt = (message, options = {}) => {
        if (!hasBootstrap()) return Promise.resolve(null);
        return openModal({
            title: options.title || 'Informe',
            message: String(message || ''),
            confirm: false,
            prompt: true,
            defaultValue: options.defaultValue || ''
        });
    };

    window.alert = (message) => {
        window.uiAlert(message);
    };
})();

(() => {
    const SELECTOR = 'button.btn, a.btn, label.btn';
    const SKIP_SELECTOR = '.btn-close, .nav-link, .accordion-button, .sort-button, .ficha-subtab, [data-ui-skip-standardize]';
    let scheduled = false;
    let syncing = false;

    const ACTIONS = [
        { key: 'novo', tests: ['novo', 'nova', 'criar', 'cadastrar', 'adicionar', 'inserir'], icon: 'fa-solid fa-plus', label: 'Novo' },
        { key: 'importar', tests: ['importar', 'upload'], icon: 'fa-solid fa-file-import', label: 'Importar' },
        { key: 'exportar', tests: ['exportar', 'excel', 'download', 'baixar modelo', 'baixar'], icon: 'fa-solid fa-folder-open', label: 'Exportar' },
        { key: 'editar', tests: ['editar', 'alterar'], icon: 'fa-solid fa-pen-to-square', label: 'Editar' },
        { key: 'excluir', tests: ['excluir', 'remover', 'deletar', 'apagar'], icon: 'fa-solid fa-trash', label: 'Remover' },
        { key: 'salvar', tests: ['salvar', 'enviar', 'gravar'], icon: 'fa-solid fa-floppy-disk', label: 'Salvar' },
        { key: 'atualizar', tests: ['atualizar', 'recarregar', 'carregar'], icon: 'fa-solid fa-rotate-right', label: 'Atualizar' },
        { key: 'filtrar', tests: ['filtrar', 'filtro', 'buscar', 'pesquisar'], icon: 'fa-solid fa-magnifying-glass', label: 'Filtrar' },
        { key: 'visualizar', tests: ['visualizar', 'ver', 'detalhes', 'encontristas', 'integrantes'], icon: 'fa-solid fa-eye', label: 'Ver' },
        { key: 'fechar', tests: ['fechar', 'cancelar'], icon: 'fa-solid fa-xmark', label: 'Fechar' },
        { key: 'voltar', tests: ['voltar', 'retornar'], icon: 'fa-solid fa-arrow-left', label: 'Voltar' },
        { key: 'configurar', tests: ['colunas', 'config', 'configurar', 'preferencias'], icon: 'fa-solid fa-gear', label: 'Configurar' },
        { key: 'acessar', tests: ['entrar', 'acessar', 'login'], icon: 'fa-solid fa-right-to-bracket', label: 'Entrar' },
        { key: 'resultado', tests: ['resultado', 'ranking'], icon: 'fa-solid fa-trophy', label: 'Resultado' },
        { key: 'movimentacao', tests: ['emprestimo', 'empréstimo', 'doacao', 'doação', 'movimentacao', 'movimentação'], icon: 'fa-solid fa-right-left', label: 'Movimentação' }
    ];

    const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();

    const getVisibleText = (button) => {
        const clone = button.cloneNode(true);
        clone.querySelectorAll('input, .btn-ejc-icon, i, svg').forEach((node) => node.remove());
        return String(clone.textContent || '').replace(/\s+/g, ' ').trim();
    };

    const resolveAction = (button, text) => {
        const source = normalize([
            text,
            button.getAttribute('title'),
            button.getAttribute('aria-label'),
            button.dataset.action
        ].filter(Boolean).join(' '));

        for (const action of ACTIONS) {
            if (action.tests.some((test) => source.includes(test))) return action;
        }

        return { key: 'padrao', icon: null, label: text || 'Ação' };
    };

    const ensureWrapper = (button, className) => {
        let wrapper = button.querySelector(`:scope > .${className}`);
        if (!wrapper) {
            wrapper = document.createElement('span');
            wrapper.className = className;
        }
        return wrapper;
    };

    const isFallbackIcon = (icon) => {
        return icon instanceof HTMLElement
            && icon.tagName === 'I'
            && icon.classList.contains('fa-circle-dot');
    };

    const ensureIcon = (button, action, iconWrapper) => {
        let icon = button.querySelector(':scope > .btn-ejc-icon > i, :scope > .btn-ejc-icon > svg');
        if (!icon) {
            icon = button.querySelector(':scope > i, :scope > svg, :scope > span > i, :scope > span > svg');
        }

        if (!action.icon) {
            if (!icon || isFallbackIcon(icon)) {
                if (icon && icon.parentElement === iconWrapper) icon.remove();
                iconWrapper.replaceChildren();
                return false;
            }

            if (icon.tagName === 'I') icon.classList.add('icon-accent');
            if (icon.parentElement !== iconWrapper) iconWrapper.replaceChildren(icon);
            return true;
        }

        if (!icon || icon.classList.contains('fa-spinner') || isFallbackIcon(icon)) {
            const iconEl = document.createElement('i');
            iconEl.className = `${action.icon} icon-accent`;
            iconWrapper.replaceChildren(iconEl);
            return true;
        }

        if (icon.tagName === 'I') icon.classList.add('icon-accent');
        if (icon.parentElement !== iconWrapper) iconWrapper.replaceChildren(icon);
        return true;
    };

    const ensureText = (button, textWrapper, fallbackText) => {
        const nodes = [];
        for (const node of Array.from(button.childNodes)) {
            if (node === textWrapper) continue;
            if (node.nodeType === Node.ELEMENT_NODE) {
                const el = node;
                if (el.classList.contains('btn-ejc-icon')) continue;
                if (el.tagName === 'INPUT' && el.type === 'file') continue;
            }
            if (node.nodeType === Node.TEXT_NODE && !node.textContent.trim()) continue;
            nodes.push(node);
        }

        if (nodes.length) {
            textWrapper.replaceChildren(...nodes);
        } else if (!textWrapper.textContent.trim()) {
            textWrapper.textContent = fallbackText;
        }
    };

    const BUTTON_VARIANT_CLASSES = [
        'dropdown-toggle',
        'btn-sm',
        'btn-lg',
        'btn-primary',
        'btn-success',
        'btn-secondary',
        'btn-warning',
        'btn-danger',
        'btn-soft-primary',
        'btn-soft-secondary',
        'btn-outline-primary',
        'btn-outline-secondary',
        'btn-outline-success',
        'btn-outline-warning',
        'btn-outline-info',
        'btn-outline-danger',
        'btn-outline-dark',
        'btn-outline-light',
        'btn-edit-standard',
        'btn-corporate-view',
        'garcom-btn-main',
        'garcom-btn-soft',
        'garcom-btn-outline',
        'garcom-btn-danger'
    ];

    const limparVariantesBotao = (button) => {
        BUTTON_VARIANT_CLASSES.forEach((cls) => button.classList.remove(cls));
    };

    const applyNovoButtonClasses = (button) => {
        limparVariantesBotao(button);
        button.classList.add('btn', 'btn-ejc-action', 'btn-sm', 'btn-edit-standard');
    };

    const applyExcluirButtonClasses = (button) => {
        limparVariantesBotao(button);
        button.classList.add('btn', 'btn-danger', 'btn-ejc-action');
    };

    const applyBotaoPadraoClasses = (button) => {
        limparVariantesBotao(button);
        button.classList.add('btn', 'btn-soft-secondary', 'dropdown-toggle', 'btn-ejc-action');
    };

    const standardizeButton = (button) => {
        if (!(button instanceof HTMLElement)) return;
        if (button.matches(SKIP_SELECTOR)) return;

        const rawText = getVisibleText(button);
        const action = resolveAction(button, rawText);
        const label = rawText || action.label;
        const iconWrapper = ensureWrapper(button, 'btn-ejc-icon');
        const textWrapper = ensureWrapper(button, 'btn-ejc-text');
        const fileInput = button.querySelector(':scope > input[type="file"]');

        button.classList.add('btn-ejc-action');
        if (action.key === 'novo') applyNovoButtonClasses(button);
        else if (action.key === 'excluir') applyExcluirButtonClasses(button);
        else applyBotaoPadraoClasses(button);

        const hasIcon = ensureIcon(button, action, iconWrapper);
        ensureText(button, textWrapper, label);

        if (hasIcon) {
            if (!iconWrapper.parentElement) button.prepend(iconWrapper);
            else if (button.firstChild !== iconWrapper) button.prepend(iconWrapper);
        } else if (iconWrapper.parentElement) {
            iconWrapper.remove();
        }

        if (!textWrapper.parentElement) {
            if (fileInput) button.insertBefore(textWrapper, fileInput);
            else button.appendChild(textWrapper);
        } else if (fileInput && textWrapper.nextSibling !== fileInput) {
            button.insertBefore(textWrapper, fileInput);
        }

        if (!button.getAttribute('title')) button.setAttribute('title', label);
        if (!button.getAttribute('aria-label')) button.setAttribute('aria-label', label);
    };

    const scanButtons = (root = document) => {
        const buttons = root.matches && root.matches(SELECTOR)
            ? [root]
            : Array.from(root.querySelectorAll ? root.querySelectorAll(SELECTOR) : []);

        if (!buttons.length) return;
        syncing = true;
        buttons.forEach(standardizeButton);
        syncing = false;
    };

    const scheduleScan = () => {
        if (scheduled) return;
        scheduled = true;
        window.requestAnimationFrame(() => {
            scheduled = false;
            scanButtons(document);
        });
    };

    const init = () => {
        scanButtons(document);

        const observer = new MutationObserver((mutations) => {
            if (syncing) return;
            for (const mutation of mutations) {
                if (mutation.type === 'childList' || mutation.type === 'characterData') {
                    scheduleScan();
                    return;
                }
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

(() => {
    const TABLE_SELECTOR = 'table.table';
    let scheduled = false;
    let syncing = false;

    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

    const isActionHeader = (text) => {
        const label = normalize(text);
        return label.includes('ação') || label.includes('acoes') || label === 'ações' || label === 'acoes';
    };

    const shouldSkipTable = (table) => {
        if (!(table instanceof HTMLTableElement)) return true;
        if (!table.tHead || !table.tBodies.length) return true;
        const headRow = table.tHead.rows[0];
        if (!headRow || headRow.cells.length < 4) return true;
        if (table.classList.contains('table-no-mobile-expand')) return true;
        if (table.closest('.modal')) return true;
        return false;
    };

    const getHeaderMeta = (table) => {
        const headRow = table.tHead.rows[0];
        return Array.from(headRow.cells).map((cell, index, all) => {
            const text = String(cell.textContent || '').replace(/\s+/g, ' ').trim();
            const isAction = isActionHeader(text) || index === all.length - 1;
            const isPrimary = index < 2 || isAction;
            return { index, text: text || `Coluna ${index + 1}`, isAction, isPrimary };
        });
    };

    const markHeader = (table, meta) => {
        const headRow = table.tHead.rows[0];
        if (!headRow.querySelector('.table-ejc-mobile-expand')) {
            const expandHead = document.createElement('th');
            expandHead.className = 'table-ejc-mobile-expand';
            expandHead.setAttribute('scope', 'col');
            expandHead.innerHTML = '<span class="visually-hidden">Expandir linha</span>';
            headRow.insertBefore(expandHead, headRow.firstChild);
        }

        Array.from(headRow.cells).forEach((cell, index) => {
            if (cell.classList.contains('table-ejc-mobile-expand')) return;
            const cellMeta = meta[cell.cellIndex - 1] ?? meta[index];
            if (!cellMeta) return;
            cell.dataset.mobileIndex = String(cellMeta.index);
            cell.classList.toggle('table-ejc-mobile-hidden', !cellMeta.isPrimary);
        });
    };

    const createExpandButton = () => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn table-row-expand-btn';
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('title', 'Expandir linha');
        button.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
        return button;
    };

    const buildDetailItems = (row, meta) => {
        const fragment = document.createDocumentFragment();
        const dataCells = Array.from(row.cells).filter((cell) => !cell.classList.contains('table-ejc-mobile-expand'));

        dataCells.forEach((cell) => {
            const index = Number(cell.dataset.mobileIndex || '-1');
            const cellMeta = meta.find((item) => item.index === index);
            if (!cellMeta || cellMeta.isPrimary) return;
            const value = String(cell.textContent || '').replace(/\s+/g, ' ').trim();
            if (!value || value === '-') return;

            const item = document.createElement('div');
            item.className = 'table-ejc-detail-item';
            item.innerHTML = `
                <span class="table-ejc-detail-label">${cellMeta.text}</span>
                <div class="table-ejc-detail-value">${value}</div>
            `;
            fragment.appendChild(item);
        });

        return fragment;
    };

    const syncSpecialRow = (row, columnCount) => {
        if (!row.cells.length) return;
        if (row.dataset.mobileSpecialProcessed === 'true') return;
        const onlyCell = row.cells.length === 1 ? row.cells[0] : null;
        if (!onlyCell || !onlyCell.hasAttribute('colspan')) return;

        const expandCell = document.createElement('td');
        expandCell.className = 'table-ejc-mobile-expand';
        expandCell.innerHTML = '&nbsp;';
        row.insertBefore(expandCell, row.firstChild);
        onlyCell.colSpan = columnCount;
        row.dataset.mobileSpecialProcessed = 'true';
    };

    const enhanceBody = (table, meta) => {
        const columnCount = meta.length;
        Array.from(table.tBodies).forEach((tbody) => {
            const rows = Array.from(tbody.rows);
            rows.forEach((row) => {
                if (row.classList.contains('table-ejc-detail-row')) return;
                if (row.dataset.mobileEnhanced === 'true') return;

                if (row.cells.length !== columnCount) {
                    syncSpecialRow(row, columnCount);
                    row.dataset.mobileEnhanced = 'true';
                    return;
                }

                Array.from(row.cells).forEach((cell, index) => {
                    const cellMeta = meta[index];
                    cell.dataset.mobileIndex = String(cellMeta.index);
                    cell.classList.toggle('table-ejc-mobile-hidden', !cellMeta.isPrimary);
                });

                const expandCell = document.createElement('td');
                expandCell.className = 'table-ejc-mobile-expand';
                const expandBtn = createExpandButton();
                expandCell.appendChild(expandBtn);
                row.insertBefore(expandCell, row.firstChild);

                const detailRow = document.createElement('tr');
                detailRow.className = 'table-ejc-detail-row';
                const detailCell = document.createElement('td');
                detailCell.className = 'table-ejc-detail-cell';
                detailCell.colSpan = columnCount + 1;

                const detailGrid = document.createElement('div');
                detailGrid.className = 'table-ejc-detail-grid';
                detailGrid.appendChild(buildDetailItems(row, meta));

                if (!detailGrid.childElementCount) {
                    const empty = document.createElement('div');
                    empty.className = 'table-ejc-detail-item';
                    empty.innerHTML = `
                        <span class="table-ejc-detail-label">Detalhes</span>
                        <div class="table-ejc-detail-value">Nenhuma informação adicional.</div>
                    `;
                    detailGrid.appendChild(empty);
                }

                detailCell.appendChild(detailGrid);
                detailRow.appendChild(detailCell);
                row.insertAdjacentElement('afterend', detailRow);

                expandBtn.addEventListener('click', () => {
                    const isOpen = detailRow.classList.toggle('is-open');
                    expandBtn.setAttribute('aria-expanded', String(isOpen));
                    expandBtn.setAttribute('title', isOpen ? 'Recolher linha' : 'Expandir linha');
                    expandBtn.innerHTML = `<i class="fa-solid ${isOpen ? 'fa-chevron-up' : 'fa-chevron-down'}"></i>`;
                });

                row.dataset.mobileEnhanced = 'true';
            });
        });
    };

    const enhanceTable = (table) => {
        if (shouldSkipTable(table)) return;
        const meta = getHeaderMeta(table);
        if (!meta.length) return;
        table.classList.add('table-ejc-responsive-ready');
        markHeader(table, meta);
        enhanceBody(table, meta);
    };

    const scanTables = (root = document) => {
        const tables = root.matches && root.matches(TABLE_SELECTOR)
            ? [root]
            : Array.from(root.querySelectorAll ? root.querySelectorAll(TABLE_SELECTOR) : []);

        if (!tables.length) return;
        syncing = true;
        tables.forEach(enhanceTable);
        syncing = false;
    };

    const scheduleScan = () => {
        if (scheduled) return;
        scheduled = true;
        window.requestAnimationFrame(() => {
            scheduled = false;
            scanTables(document);
        });
    };

    const init = () => {
        scanTables(document);
        const observer = new MutationObserver((mutations) => {
            if (syncing) return;
            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    scheduleScan();
                    return;
                }
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
