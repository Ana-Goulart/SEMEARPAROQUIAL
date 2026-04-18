const crypto = require('crypto');

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'sj_session';
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function getSecret() {
    return process.env.SESSION_SECRET || 'semeajovens-dev-secret-change-me';
}

function getCookieDomain() {
    const domain = String(process.env.SESSION_COOKIE_DOMAIN || '').trim();
    return domain || undefined;
}

function isCookieSecure() {
    const raw = String(process.env.SESSION_COOKIE_SECURE || '').trim().toLowerCase();
    if (!raw) return true;
    return raw === '1' || raw === 'true' || raw === 'yes';
}

function base64url(input) {
    return Buffer.from(input).toString('base64url');
}

function hmac(input) {
    return crypto.createHmac('sha256', getSecret()).update(input).digest('base64url');
}

function createSessionToken(userId, maxAgeMs = DEFAULT_MAX_AGE_MS) {
    const exp = Date.now() + maxAgeMs;
    const payload = JSON.stringify({ userId, exp });
    const payloadB64 = base64url(payload);
    const sig = hmac(payloadB64);
    return `${payloadB64}.${sig}`;
}

function verifySessionToken(token) {
    try {
        if (!token || typeof token !== 'string') return null;
        const [payloadB64, sig] = token.split('.');
        if (!payloadB64 || !sig) return null;

        const expected = hmac(payloadB64);
        if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

        const payloadRaw = Buffer.from(payloadB64, 'base64url').toString('utf8');
        const payload = JSON.parse(payloadRaw);
        if (!payload || !payload.userId || !payload.exp) return null;
        if (Date.now() > Number(payload.exp)) return null;
        return Number(payload.userId);
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

function attachUserFromSession(req, _res, next) {
    const cookies = parseCookies(req);
    const token = cookies[COOKIE_NAME];
    const userId = verifySessionToken(token);
    if (userId) req.user = { id: userId };
    next();
}

function setSessionCookie(res, userId) {
    const token = createSessionToken(userId);
    res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: isCookieSecure(),
        domain: getCookieDomain(),
        maxAge: DEFAULT_MAX_AGE_MS,
        path: '/'
    });
}

function clearSessionCookie(res) {
    res.clearCookie(COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'lax',
        secure: isCookieSecure(),
        domain: getCookieDomain(),
        path: '/'
    });
}

module.exports = {
    COOKIE_NAME,
    attachUserFromSession,
    setSessionCookie,
    clearSessionCookie
};
