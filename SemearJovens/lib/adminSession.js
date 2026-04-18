const crypto = require('crypto');

const COOKIE_NAME = 'sj_admin_session';
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function getSecret() {
    return process.env.SESSION_SECRET || 'semeajovens-dev-secret-change-me';
}

function base64url(input) {
    return Buffer.from(input).toString('base64url');
}

function hmac(input) {
    return crypto.createHmac('sha256', getSecret()).update(input).digest('base64url');
}

function createToken(adminId, maxAgeMs = DEFAULT_MAX_AGE_MS) {
    const exp = Date.now() + maxAgeMs;
    const payload = JSON.stringify({ adminId, exp });
    const payloadB64 = base64url(payload);
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
        if (!payload || !payload.adminId || !payload.exp) return null;
        if (Date.now() > Number(payload.exp)) return null;
        return Number(payload.adminId);
    } catch (_) {
        return null;
    }
}

function parseCookies(req) {
    const header = req.headers.cookie || '';
    const pairs = header.split(';').map(v => v.trim()).filter(Boolean);
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
    const adminId = verifyToken(token);
    if (adminId) req.admin = { id: adminId };
    next();
}

function setAdminSessionCookie(res, adminId) {
    const token = createToken(adminId);
    res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        maxAge: DEFAULT_MAX_AGE_MS,
        path: '/'
    });
}

function clearAdminSessionCookie(res) {
    res.clearCookie(COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        path: '/'
    });
}

module.exports = {
    attachAdminFromSession,
    setAdminSessionCookie,
    clearAdminSessionCookie
};

