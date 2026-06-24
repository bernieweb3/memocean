export type EncryptContext = {
  projectId: string;
  sessionId: string;
  memoryId: string;
  keyVersion: number;
  projectSalt: Uint8Array;
};

export type EncryptedEnvelope = {
  version: 1;
  alg: "AES-256-GCM";
  kdf: "HKDF-SHA256";
  keyVersion: number;
  projectId: string;
  sessionId: string;
  memoryId: string;
  iv: string;
  ciphertext: string;
};

const ENVELOPE_VERSION = 1 as const;
const ALG = "AES-256-GCM" as const;
const KDF = "HKDF-SHA256" as const;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const PROJECT_SALT_BYTES = 32;

function assertId(value: string, name: string): void {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(value)) {
    throw new Error(`${name} invalid format`);
  }
}

function assertProjectSalt(projectSalt: Uint8Array): void {
  if (!(projectSalt instanceof Uint8Array) || projectSalt.byteLength !== PROJECT_SALT_BYTES) {
    throw new Error("projectSalt must be 32 bytes");
  }
}

function assertKeyVersion(keyVersion: number): void {
  if (!Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion > 1_000_000) {
    throw new Error("Invalid keyVersion");
  }
}

function getCrypto(): Crypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
    throw new Error("WebCrypto is unavailable");
  }
  return globalThis.crypto;
}

function toBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  const BufferCtor = (globalThis as unknown as { Buffer?: typeof Buffer }).Buffer;
  if (!BufferCtor) throw new Error("Base64 encoder unavailable");
  return BufferCtor.from(bytes).toString("base64");
}

function fromBase64(value: string, name: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || value.length > 20 * 1024 * 1024) {
    throw new Error(`${name} invalid base64`);
  }

  try {
    if (typeof atob === "function") {
      const binary = atob(value);
      return Uint8Array.from(binary, c => c.charCodeAt(0));
    }

    const BufferCtor = (globalThis as unknown as { Buffer?: typeof Buffer }).Buffer;
    if (!BufferCtor) throw new Error("Base64 decoder unavailable");
    return new Uint8Array(BufferCtor.from(value, "base64"));
  } catch {
    throw new Error(`${name} invalid base64`);
  }
}

function assertEnvelope(envelope: EncryptedEnvelope): void {
  if (!envelope || typeof envelope !== "object") throw new Error("Invalid encrypted envelope");
  if (envelope.version !== ENVELOPE_VERSION) throw new Error("Unsupported envelope version");
  if (envelope.alg !== ALG) throw new Error("Unsupported algorithm");
  if (envelope.kdf !== KDF) throw new Error("Unsupported KDF");
  assertKeyVersion(envelope.keyVersion);
  assertId(envelope.projectId, "projectId");
  assertId(envelope.sessionId, "sessionId");
  assertId(envelope.memoryId, "memoryId");
}

function normalizeMasterSecret(masterSecret: Uint8Array | string): Uint8Array {
  if (masterSecret instanceof Uint8Array) {
    if (masterSecret.byteLength < 32) throw new Error("masterSecret must be at least 32 bytes");
    return new Uint8Array(masterSecret);
  }

  if (typeof masterSecret === "string") {
    if (masterSecret.length < 32) throw new Error("masterSecret must be at least 32 chars");
    return new TextEncoder().encode(masterSecret);
  }

  throw new Error("masterSecret is required");
}

export function generateProjectSalt(): Uint8Array {
  const salt = new Uint8Array(PROJECT_SALT_BYTES);
  getCrypto().getRandomValues(salt);
  return salt;
}

export class CryptoModule {
  private masterSecret?: Uint8Array;

  constructor(masterSecret: Uint8Array | string) {
    this.masterSecret = normalizeMasterSecret(masterSecret);
  }

  destroy(): void {
    this.masterSecret?.fill(0);
    this.masterSecret = undefined;
  }

  private async deriveProjectKeyMaterial(projectSalt: Uint8Array, projectId: string): Promise<Uint8Array> {
    if (!this.masterSecret) throw new Error("CryptoModule destroyed");
    assertProjectSalt(projectSalt);
    assertId(projectId, "projectId");

    const subtle = getCrypto().subtle;
    const imported = await subtle.importKey("raw", this.masterSecret, "HKDF", false, ["deriveBits"]);
    const bits = await subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: projectSalt,
        info: new TextEncoder().encode(`memocean:v1:project:${projectId}`),
      },
      imported,
      256
    );

    return new Uint8Array(bits);
  }

  private async deriveSessionKey(
    projectKeyMaterial: Uint8Array,
    sessionId: string,
    keyVersion: number
  ): Promise<CryptoKey> {
    assertId(sessionId, "sessionId");
    assertKeyVersion(keyVersion);

    const subtle = getCrypto().subtle;
    const imported = await subtle.importKey("raw", projectKeyMaterial, "HKDF", false, ["deriveKey"]);

    return subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(32),
        info: new TextEncoder().encode(
          `memocean:v1:session:${sessionId}:keyVersion:${keyVersion}:aes-gcm`
        ),
      },
      imported,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async encrypt(plaintext: string, ctx: EncryptContext): Promise<EncryptedEnvelope> {
    if (typeof plaintext !== "string") throw new Error("plaintext must be string");
    assertId(ctx.projectId, "projectId");
    assertId(ctx.sessionId, "sessionId");
    assertId(ctx.memoryId, "memoryId");
    assertKeyVersion(ctx.keyVersion);
    assertProjectSalt(ctx.projectSalt);

    const projectKeyMaterial = await this.deriveProjectKeyMaterial(ctx.projectSalt, ctx.projectId);

    try {
      const sessionKey = await this.deriveSessionKey(projectKeyMaterial, ctx.sessionId, ctx.keyVersion);
      const iv = new Uint8Array(IV_BYTES);
      getCrypto().getRandomValues(iv);

      const plaintextBytes = new TextEncoder().encode(plaintext);
      const aad = new TextEncoder().encode(
        `memocean:v1:${ctx.projectId}:${ctx.sessionId}:${ctx.memoryId}:${ctx.keyVersion}`
      );

      try {
        const ciphertext = new Uint8Array(
          await getCrypto().subtle.encrypt(
            { name: "AES-GCM", iv, tagLength: 128, additionalData: aad },
            sessionKey,
            plaintextBytes
          )
        );

        return {
          version: ENVELOPE_VERSION,
          alg: ALG,
          kdf: KDF,
          keyVersion: ctx.keyVersion,
          projectId: ctx.projectId,
          sessionId: ctx.sessionId,
          memoryId: ctx.memoryId,
          iv: toBase64(iv),
          ciphertext: toBase64(ciphertext),
        };
      } finally {
        plaintextBytes.fill(0);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Invalid")) throw error;
      throw new Error("Encryption failed");
    } finally {
      projectKeyMaterial.fill(0);
    }
  }

  async decrypt(envelope: EncryptedEnvelope, projectSalt: Uint8Array): Promise<string> {
    assertEnvelope(envelope);
    assertProjectSalt(projectSalt);

    const iv = fromBase64(envelope.iv, "iv");
    const ciphertext = fromBase64(envelope.ciphertext, "ciphertext");

    if (iv.byteLength !== IV_BYTES) throw new Error("Invalid IV length");
    if (ciphertext.byteLength < GCM_TAG_BYTES) throw new Error("Ciphertext too short");

    const projectKeyMaterial = await this.deriveProjectKeyMaterial(projectSalt, envelope.projectId);

    try {
      const sessionKey = await this.deriveSessionKey(projectKeyMaterial, envelope.sessionId, envelope.keyVersion);
      const aad = new TextEncoder().encode(
        `memocean:v1:${envelope.projectId}:${envelope.sessionId}:${envelope.memoryId}:${envelope.keyVersion}`
      );

      const plaintextBytes = await getCrypto().subtle.decrypt(
        { name: "AES-GCM", iv, tagLength: 128, additionalData: aad },
        sessionKey,
        ciphertext
      );

      return new TextDecoder().decode(plaintextBytes);
    } catch {
      throw new Error("Decryption failed");
    } finally {
      projectKeyMaterial.fill(0);
    }
  }
}
