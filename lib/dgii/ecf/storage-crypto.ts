import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type EncryptedXml = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
};

export class StorageEncryptionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageEncryptionConfigurationError";
  }
}

export function loadStorageEncryptionKey(value: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(value, "base64");
  } catch {
    throw new StorageEncryptionConfigurationError(
      "DGII_STORAGE_ENCRYPTION_KEY_BASE64 nao e Base64 valido",
    );
  }
  if (key.length !== 32 || key.toString("base64") !== value.trim()) {
    throw new StorageEncryptionConfigurationError(
      "DGII_STORAGE_ENCRYPTION_KEY_BASE64 deve conter exatamente 32 bytes em Base64 canonico",
    );
  }
  return key;
}

export function encryptSignedXml(xml: string, key: Buffer): EncryptedXml {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(xml, "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function decryptSignedXml(value: EncryptedXml, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, value.iv);
  decipher.setAuthTag(value.authTag);
  return Buffer.concat([
    decipher.update(value.ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
