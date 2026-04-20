function normalizeTrimmedText(value) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text || null;
}

function normalizeUpperText(value) {
    const text = normalizeTrimmedText(value);
    return text ? text.toLocaleUpperCase('pt-BR') : null;
}

function toUpperDisplayText(value) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    return text ? text.toLocaleUpperCase('pt-BR') : '';
}

const DIRECT_PERSON_NAME_KEYS = new Set([
    'nome_completo',
    'apelido',
    'nome_tio',
    'nome_tia',
    'tio_nome_tio',
    'tio_nome_tia',
    'nome_tio_snapshot',
    'nome_tia_snapshot',
    'conjuge_nome',
    'conjuge'
]);

const PERSON_NAME_PARENT_KEYS = new Set([
    'cadastro',
    'principal',
    'conjuge',
    'tio',
    'tia'
]);

function isPlainObject(value) {
    if (!value || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function shouldUppercaseField({ key, parentKey, owner, reqPath }) {
    if (DIRECT_PERSON_NAME_KEYS.has(key)) return true;
    if (key !== 'nome') return false;
    if (PERSON_NAME_PARENT_KEYS.has(parentKey)) return true;
    if (reqPath === '/api/jovens-outro-ejc-public/membros') return true;
    if (owner && (Object.prototype.hasOwnProperty.call(owner, 'nome_tio') || Object.prototype.hasOwnProperty.call(owner, 'nome_tia'))) {
        return true;
    }
    return false;
}

function uppercasePersonNamePayload(payload, { reqPath } = {}) {
    const seen = new WeakMap();

    const visit = (value, parentKey = null) => {
        if (Array.isArray(value)) {
            return value.map((item) => visit(item, parentKey));
        }

        if (!isPlainObject(value)) {
            return value;
        }

        if (seen.has(value)) {
            return seen.get(value);
        }

        const clone = {};
        seen.set(value, clone);

        Object.entries(value).forEach(([key, currentValue]) => {
            if (typeof currentValue === 'string' && shouldUppercaseField({ key, parentKey, owner: value, reqPath })) {
                clone[key] = toUpperDisplayText(currentValue);
                return;
            }
            clone[key] = visit(currentValue, key);
        });

        return clone;
    };

    return visit(payload);
}

function personNameResponseMiddleware(req, res, next) {
    const originalJson = res.json.bind(res);
    res.json = (payload) => originalJson(uppercasePersonNamePayload(payload, { reqPath: req.path }));
    next();
}

module.exports = {
    normalizeUpperText,
    personNameResponseMiddleware,
    uppercasePersonNamePayload
};
