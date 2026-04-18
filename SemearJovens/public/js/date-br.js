(() => {
    const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;
    const MONTHS = [
        'janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho',
        'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
    ];
    const MONTHS_MAP = new Map([
        ['jan', 1], ['janeiro', 1],
        ['fev', 2], ['fevereiro', 2],
        ['mar', 3], ['marco', 3], ['março', 3],
        ['abr', 4], ['abril', 4],
        ['mai', 5], ['maio', 5],
        ['jun', 6], ['junho', 6],
        ['jul', 7], ['julho', 7],
        ['ago', 8], ['agosto', 8],
        ['set', 9], ['setembro', 9],
        ['out', 10], ['outubro', 10],
        ['nov', 11], ['novembro', 11],
        ['dez', 12], ['dezembro', 12]
    ]);

    function formatDateInput(value) {
        const digits = String(value || '').replace(/\D/g, '').slice(0, 8);
        if (!digits) return '';
        if (digits.length <= 2) return digits;
        if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
        return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
    }

    function cursorFromDigits(formatted, digitCount) {
        if (!digitCount) return 0;
        let count = 0;
        for (let i = 0; i < formatted.length; i++) {
            if (/\d/.test(formatted[i])) count++;
            if (count >= digitCount) return i + 1;
        }
        return formatted.length;
    }

    function parseBrDate(value) {
        const raw = String(value || '').trim().toLowerCase();
        if (DATE_RE.test(raw)) {
            const [dd, mm, yyyy] = raw.split('/');
            return { dd, mm, yyyy };
        }
        const m = raw.match(/^(\d{2})\/([a-zçãéíóú]+)\/(\d{4})$/i);
        if (m) {
            const dd = m[1];
            const monthKey = m[2].normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            const mmNum = MONTHS_MAP.get(monthKey);
            if (mmNum) return { dd, mm: String(mmNum).padStart(2, '0'), yyyy: m[3] };
        }
        return null;
    }

    function toIsoDate(value) {
        const parsed = parseBrDate(value);
        if (!parsed) return value;
        const { dd, mm, yyyy } = parsed;
        return `${yyyy}-${mm}-${dd}`;
    }

    function toBrDate(value) {
        const m = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) return value;
        const monthIdx = Number(m[2]) - 1;
        const monthName = MONTHS[monthIdx] || m[2];
        return `${m[3]}/${monthName}/${m[1]}`;
    }

    function convertDates(obj) {
        if (Array.isArray(obj)) return obj.map(convertDates);
        if (obj && typeof obj === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(obj)) out[k] = convertDates(v);
            return out;
        }
        if (typeof obj === 'string' && (DATE_RE.test(obj) || /\d{2}\/[a-zçãéíóú]+\/\d{4}/i.test(obj))) return toIsoDate(obj);
        return obj;
    }

    document.addEventListener('input', (e) => {
        const el = e.target;
        if (!el || !el.classList || !el.classList.contains('date-br')) return;
        const value = el.value || '';
        if (/[a-zA-Z]/.test(value)) return;
        const cursor = el.selectionStart || 0;
        const digitsBefore = value.slice(0, cursor).replace(/\D/g, '').length;
        const formatted = formatDateInput(value);
        if (formatted !== value) {
            el.value = formatted;
            const newPos = cursorFromDigits(formatted, digitsBefore);
            try { el.setSelectionRange(newPos, newPos); } catch (_) { }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });

    document.addEventListener('focusin', (e) => {
        const el = e.target;
        if (!el || !el.classList || !el.classList.contains('date-br')) return;
        const br = toBrDate(el.value);
        if (br !== el.value) el.value = br;
    });

    document.addEventListener('focusout', (e) => {
        const el = e.target;
        if (!el || !el.classList || !el.classList.contains('date-br')) return;
        const parsed = parseBrDate(el.value);
        if (!parsed) return;
        const monthName = MONTHS[Number(parsed.mm) - 1] || parsed.mm;
        el.value = `${parsed.dd}/${monthName}/${parsed.yyyy}`;
    });

    function setupPicker(el) {
        if (el.dataset.datePickerReady) return;
        el.dataset.datePickerReady = '1';

        const wrapper = document.createElement('div');
        wrapper.className = 'date-br-wrap';
        el.parentNode.insertBefore(wrapper, el);
        wrapper.appendChild(el);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'date-br-btn';
        btn.title = 'Selecionar data';
        btn.innerHTML = '📅';
        wrapper.appendChild(btn);

        const hidden = document.createElement('input');
        hidden.type = 'date';
        hidden.className = 'date-br-hidden';
        wrapper.appendChild(hidden);

        const syncHidden = () => {
            const iso = toIsoDate(el.value);
            if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) hidden.value = iso;
        };

        const syncVisible = () => {
            const br = toBrDate(hidden.value);
            if (br) el.value = br;
        };

        btn.addEventListener('click', () => {
            syncHidden();
            if (hidden.showPicker) hidden.showPicker();
            else hidden.click();
        });

        hidden.addEventListener('change', () => {
            syncVisible();
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });

        el.addEventListener('change', syncHidden);
        syncHidden();
    }

    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('input.date-br').forEach((el) => {
            const br = toBrDate(el.value);
            if (br !== el.value) el.value = br;
            if (el.placeholder && /dd\/mm\/aaaa/i.test(el.placeholder)) {
                el.placeholder = 'dd/mês/aaaa';
            }
            setupPicker(el);
        });
    });

    const originalFetch = window.fetch;
    window.fetch = function (input, init = {}) {
        try {
            const headers = init.headers || {};
            let contentType = '';
            if (headers instanceof Headers) {
                contentType = headers.get('Content-Type') || headers.get('content-type') || '';
            } else {
                contentType = headers['Content-Type'] || headers['content-type'] || '';
            }
            if (init.body && typeof init.body === 'string' && /application\/json/i.test(contentType)) {
                const parsed = JSON.parse(init.body);
                const converted = convertDates(parsed);
                init.body = JSON.stringify(converted);
            }
        } catch (_) { }
        return originalFetch(input, init);
    };
})();
