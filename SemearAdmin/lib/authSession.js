const crypto = require('crypto');

const COOKIE_NAME = 'sp_tenant_admin_session';
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || '').trim() === '1';

function getSecret() {
    return process.env.SESSION_SECRET || 'semear-admin-dev-secret-change-me';
}

function base64url(input) {
    return Buffer.from(input).toString('base64url');
}

function hmac(input) {
    return crypto.createHmac('sha256', getSecret()).update(input).digest('base64url');
}

function createToken(payload, maxAgeMs = DEFAULT_MAX_AGE_MS) {
    const exp = Date.now() + maxAgeMs;
    const body = JSON.stringify({ ...payload, exp });
    const payloadB64 = base64url(body);
    const sig = hmac(payloadB64);
    return `${payloadB64}.${sig}`;
}

function verifyToken(token) {
    try {
        if (!token || typeof token !== 'string') return null;
        const [payloadB64, sig] = token.split('.');
        if (!payloadB64 || !sig) return null;
        const expected = hmac(payloadB64);
        if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

        const payloadRaw = Buffer.from(payloadB64, 'base64url').toString('utf8');
        const payload = JSON.parse(payloadRaw);
        if (!payload || !payload.adminId || !payload.tenantId || !payload.exp) return null;
        if (Date.now() > Number(payload.exp)) return null;
        return {
            adminId: Number(payload.adminId),
            tenantId: Number(payload.tenantId)
        };
    } catch (_) {
        return null;
    }
}

function parseCookies(req) {
    const header = req.headers.cookie || '';
    const pairs = header.split(';').map((v) => v.trim()).filter(Boolean);
    const out = {};
    for (const p of pairs) {
        const i = p.indexOf('=');
        if (i === -1) continue;
        const k = p.slice(0, i).trim();
        const v = p.slice(i + 1).trim();
        out[k] = decodeURIComponent(v);
    }
    return out;
}

function attachAdminFromSession(req, _res, next) {
    const cookies = parseCookies(req);
    const token = cookies[COOKIE_NAME];
    const data = verifyToken(token);
    if (data) req.admin = { id: data.adminId, tenant_id: data.tenantId };
    next();
}

function setAdminSessionCookie(res, adminId, tenantId) {
    const token = createToken({ adminId, tenantId });
    res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: COOKIE_SECURE,
        maxAge: DEFAULT_MAX_AGE_MS,
        path: '/'
    });
}

function clearAdminSessionCookie(res) {
    res.clearCookie(COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'lax',
        secure: COOKIE_SECURE,
        path: '/'
    });
}

module.exports = {
    attachAdminFromSession,
    setAdminSessionCookie,
    clearAdminSessionCookie
};
