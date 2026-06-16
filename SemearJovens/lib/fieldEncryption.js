const crypto = require('crypto');

const ENCRYPTION_PREFIX = 'enc:v1';
const ENCRYPTION_ALGORITHM = 'aes-256-cbc';

function resolveBaseKey() {
    const raw = String(
        process.env.DATA_ENCRYPTION_KEY
        || process.env.LGPD_DATA_ENCRYPTION_KEY
        || process.env.APP_DATA_ENCRYPTION_KEY
        || process.env.SESSION_SECRET
        || ''
    ).trim();

    if (!raw) {
        throw new Error('Defina DATA_ENCRYPTION_KEY para habilitar a criptografia dos dados sensíveis.');
    }

    if (/^[a-f0-9]{64}$/i.test(raw)) {
        return Buffer.from(raw, 'hex');
    }

    try {
        const decoded = Buffer.from(raw, 'base64');
        if (decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '')) {
            return decoded;
        }
    } catch (_) { }

    return crypto.createHash('sha256').update(raw).digest();
}

function deriveKey(purpose) {
    return crypto
        .createHmac('sha256', resolveBaseKey())
        .update(String(purpose || 'default'))
        .digest();
}

function isEncryptedValue(value) {
    return typeof value === 'string' && value.startsWith(`${ENCRYPTION_PREFIX}:`);
}

function encryptValue(value, purpose = 'field') {
    if (value === undefined || value === null || value === '') return null;
    if (isEncryptedValue(value)) return value;

    const plaintext = String(value);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, deriveKey(purpose), iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${ENCRYPTION_PREFIX}:${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptValue(value, purpose = 'field', options = {}) {
    if (value === undefined || value === null || value === '') return null;
    if (!isEncryptedValue(value)) return String(value);

    const [, , ivHex, payloadHex] = String(value).split(':');
    if (!ivHex || !payloadHex) return String(value);

    try {
        const decipher = crypto.createDecipheriv(
            ENCRYPTION_ALGORITHM,
            deriveKey(purpose),
            Buffer.from(ivHex, 'hex')
        );
        const decrypted = Buffer.concat([
            decipher.update(Buffer.from(payloadHex, 'hex')),
            decipher.final()
        ]);
        return decrypted.toString('utf8');
    } catch (err) {
        if (!options || !options.silent) {
            console.error('Falha ao descriptografar campo sensível:', err);
        }
        return null;
    }
}

function blindIndex(value, purpose = 'field') {
    if (value === undefined || value === null || value === '') return null;
    return crypto
        .createHmac('sha256', deriveKey(`blind:${purpose}`))
        .update(String(value))
        .digest('hex');
}

module.exports = {
    blindIndex,
    decryptValue,
    encryptValue,
    isEncryptedValue
};
