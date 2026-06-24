// packages/crypto/src/index.ts

export class CryptoModule {
  constructor(private masterSecret: string) {}

  private async deriveKey(secret: string, salt: string, info: string): Promise<CryptoKey> {
    const enc = new TextEncoder();
    const saltBytes = enc.encode(salt);
    const secretBytes = enc.encode(secret);
    const infoBytes = enc.encode(info);

    const importedSecret = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HKDF" },
      false,
      ["deriveKey"]
    );

    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: saltBytes,
        info: infoBytes,
      },
      importedSecret,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async encrypt(plaintext: string, sessionId: string): Promise<Uint8Array> {
    const key = await this.deriveKey(this.masterSecret, "hkdf-salt", sessionId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const plaintextBytes = enc.encode(plaintext);

    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv, tagLength: 128 },
      key,
      plaintextBytes
    );

    const result = new Uint8Array(iv.length + ciphertext.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(ciphertext), iv.length);

    return result;
  }

  async decrypt(ciphertext: Uint8Array, sessionId: string): Promise<string> {
    const key = await this.deriveKey(this.masterSecret, "hkdf-salt", sessionId);
    const iv = ciphertext.slice(0, 12);
    const actualCiphertext = ciphertext.slice(12);

    const plaintextBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv, tagLength: 128 },
      key,
      actualCiphertext
    );

    const dec = new TextDecoder();
    return dec.decode(plaintextBytes);
  }
}