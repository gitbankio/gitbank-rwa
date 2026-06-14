import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

function getMasterKey(): Buffer {
  const raw = process.env["ENCRYPTION_MASTER_KEY"];
  if (!raw) throw new Error("ENCRYPTION_MASTER_KEY is not set");
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== KEY_LENGTH)
    throw new Error(`ENCRYPTION_MASTER_KEY must be ${KEY_LENGTH * 2} hex chars`);
  return buf;
}

/** Encrypt a Solana private key (base58 string) → stored cipher string */
export function encryptSolanaKey(privateKeyBase58: string): string {
  const masterKey = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(privateKeyBase58, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv.toString("hex"), tag.toString("hex"), encrypted.toString("hex")].join(":");
}

/** Decrypt stored cipher string → Solana private key (base58 string) */
export function decryptSolanaKey(encrypted: string): string {
  const masterKey = getMasterKey();
  const parts = encrypted.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted Solana key format");
  const [ivHex, tagHex, ciphertextHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
