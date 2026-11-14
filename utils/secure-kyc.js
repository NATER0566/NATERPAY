'use strict';

const crypto = require('crypto');

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';

function key() {
    return crypto.createHash('sha256')
        .update(String(process.env.KYC_ENCRYPTION_KEY || process.env.JWT_SECRET || ''))
        .digest();
}

function encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
    const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return `${VERSION}:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}

function decrypt(value) {
    if (!value) return null;
    const [version, ivText, tagText, encryptedText] = String(value).split(':');
    if (version !== VERSION || !ivText || !tagText || !encryptedText) return null;
    try {
        const decipher = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(ivText, 'base64url'));
        decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
        return Buffer.concat([
            decipher.update(Buffer.from(encryptedText, 'base64url')),
            decipher.final()
        ]).toString('utf8');
    } catch (_) {
        return null;
    }
}

module.exports = { encrypt, decrypt };
