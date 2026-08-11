import fs from 'node:fs';
import path from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

const TEXT_PREFIX = 'lambda:v1';
const BINARY_MAGIC = Buffer.from('LAMBDAE1');
const KEY_WRAP_AAD = Buffer.from('lambda:key-wrap:v1');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function deriveKey(password, salt) {
  return scryptSync(String(password), salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

function encryptAesGcm(key, plaintext, aad) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, tag: cipher.getAuthTag(), ciphertext };
}

function decryptAesGcm(key, nonce, tag, ciphertext, aad) {
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function keyFileContents(password, dataKey) {
  const salt = randomBytes(16);
  const wrappingKey = deriveKey(password, salt);
  const wrapped = encryptAesGcm(wrappingKey, dataKey, KEY_WRAP_AAD);
  return {
    version: 1,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64url'),
    nonce: wrapped.nonce.toString('base64url'),
    tag: wrapped.tag.toString('base64url'),
    wrappedKey: wrapped.ciphertext.toString('base64url'),
  };
}

function unwrapKey(password, metadata) {
  if (metadata?.version !== 1 || metadata?.kdf !== 'scrypt' || metadata?.cipher !== 'aes-256-gcm') {
    throw new Error('Unsupported Lambda encryption metadata.');
  }
  const salt = Buffer.from(metadata.salt, 'base64url');
  const wrappingKey = deriveKey(password, salt);
  return decryptAesGcm(
    wrappingKey,
    Buffer.from(metadata.nonce, 'base64url'),
    Buffer.from(metadata.tag, 'base64url'),
    Buffer.from(metadata.wrappedKey, 'base64url'),
    KEY_WRAP_AAD,
  );
}

export class EncryptionVault {
  constructor(password, keyPath = '') {
    this.keyPath = keyPath;
    this.dataKey = this.loadOrCreateDataKey(password);
  }

  loadOrCreateDataKey(password) {
    if (!this.keyPath) return randomBytes(32);

    if (fs.existsSync(this.keyPath)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(this.keyPath, 'utf8'));
        const key = unwrapKey(password, metadata);
        if (key.length !== 32) throw new Error('Invalid data key length.');
        return key;
      } catch {
        throw new Error('Lambda encrypted data could not be unlocked with the configured app password.');
      }
    }

    const dataKey = randomBytes(32);
    fs.mkdirSync(path.dirname(this.keyPath), { recursive: true });
    const metadata = keyFileContents(password, dataKey);
    fs.writeFileSync(this.keyPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return dataKey;
  }

  encryptText(value, context) {
    const encrypted = encryptAesGcm(this.dataKey, Buffer.from(String(value), 'utf8'), context);
    return [
      TEXT_PREFIX,
      encrypted.nonce.toString('base64url'),
      encrypted.tag.toString('base64url'),
      encrypted.ciphertext.toString('base64url'),
    ].join(':');
  }

  decryptText(value, context) {
    const parts = String(value).split(':');
    if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== TEXT_PREFIX) {
      throw new Error('Encrypted Lambda text has an invalid format.');
    }
    return decryptAesGcm(
      this.dataKey,
      Buffer.from(parts[2], 'base64url'),
      Buffer.from(parts[3], 'base64url'),
      Buffer.from(parts[4], 'base64url'),
      context,
    ).toString('utf8');
  }

  encryptJson(value, context) {
    return this.encryptText(JSON.stringify(value), context);
  }

  decryptJson(value, context) {
    return JSON.parse(this.decryptText(value, context));
  }

  encryptBytes(value, context) {
    const encrypted = encryptAesGcm(this.dataKey, Buffer.from(value), context);
    return Buffer.concat([BINARY_MAGIC, encrypted.nonce, encrypted.tag, encrypted.ciphertext]);
  }

  decryptBytes(value, context) {
    const buffer = Buffer.from(value);
    const headerBytes = BINARY_MAGIC.length + NONCE_BYTES + TAG_BYTES;
    if (buffer.length < headerBytes || !buffer.subarray(0, BINARY_MAGIC.length).equals(BINARY_MAGIC)) {
      throw new Error('Encrypted Lambda binary data has an invalid format.');
    }
    const nonceStart = BINARY_MAGIC.length;
    const tagStart = nonceStart + NONCE_BYTES;
    const ciphertextStart = tagStart + TAG_BYTES;
    return decryptAesGcm(
      this.dataKey,
      buffer.subarray(nonceStart, tagStart),
      buffer.subarray(tagStart, ciphertextStart),
      buffer.subarray(ciphertextStart),
      context,
    );
  }
}
