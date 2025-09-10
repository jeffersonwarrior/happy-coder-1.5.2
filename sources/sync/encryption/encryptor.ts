import { decryptBox, decryptSecretBox, encryptBox, encryptSecretBox } from "@/encryption/libsodium";
import { encodeBase64, decodeBase64 } from "@/auth/base64";
import * as crypto from 'rn-encryption';
import sodium from 'react-native-libsodium';
import { decodeUTF8 } from "@/encryption/text";

//
// IMPORTANT: Right now there is a bug in the AES implementation and it works only with a normal strings converted to Uint8Array. 
// Any abnormal string might break encoding and decoding utf8.
//

export interface Encryptor {
    encrypt(data: any[]): Promise<Uint8Array[]>;
}

export interface Decryptor {
    decrypt(data: Uint8Array[]): Promise<(any | null)[]>;
}

export class SecretBoxEncryption implements Encryptor, Decryptor {
    private readonly secretKey: Uint8Array;

    constructor(secretKey: Uint8Array) {
        this.secretKey = secretKey;
    }

    async decrypt(data: Uint8Array[]): Promise<(any | null)[]> {
        // Process as batch, not Promise.all - more efficient
        const results: (any | null)[] = [];
        for (const item of data) {
            results.push(decryptSecretBox(item, this.secretKey));
        }
        return results;
    }

    async encrypt(data: any[]): Promise<Uint8Array[]> {
        // Process as batch, not Promise.all - more efficient
        const results: Uint8Array[] = [];
        for (const item of data) {
            results.push(encryptSecretBox(item, this.secretKey));
        }
        return results;
    }
}

export class BoxEncryption implements Encryptor, Decryptor {
    private readonly privateKey: Uint8Array;
    private readonly publicKey: Uint8Array;

    constructor(seed: Uint8Array) {
        // Use the seed to generate a proper keypair
        const keypair = sodium.crypto_box_seed_keypair(seed);
        this.privateKey = keypair.privateKey;
        this.publicKey = keypair.publicKey;
    }

    async encrypt(data: any[]): Promise<Uint8Array[]> {
        // Process as batch, not Promise.all - more efficient
        const results: Uint8Array[] = [];
        for (const item of data) {
            results.push(encryptBox(item, this.publicKey));
        }
        return results;
    }

    async decrypt(data: Uint8Array[]): Promise<(any | null)[]> {
        // Process as batch, not Promise.all - more efficient
        const results: (any | null)[] = [];
        for (const item of data) {
            results.push(decryptBox(item, this.privateKey));
        }
        return results;
    }
}

export class AES256Encryption implements Encryptor, Decryptor {
    private readonly secretKey: Uint8Array;
    private readonly secretKeyB64: string;

    constructor(secretKey: Uint8Array) {
        this.secretKey = secretKey;
        this.secretKeyB64 = encodeBase64(secretKey);
    }

    async encrypt(data: any[]): Promise<Uint8Array[]> {
        // Process as batch, not Promise.all - more efficient
        const results: Uint8Array[] = [];
        for (const item of data) {
            // Serialize to JSON string first
            const jsonString = JSON.stringify(item);
            const encrypted = await crypto.encryptAES(jsonString, this.secretKeyB64);
            results.push(JSON.parse(decodeUTF8(decodeBase64(encrypted))));
        }
        return results;
    }

    async decrypt(data: Uint8Array[]): Promise<(any | null)[]> {
        // Process as batch, not Promise.all - more efficient
        const results: (any | null)[] = [];
        for (const item of data) {
            try {
                const decryptedString = await crypto.decryptAES(encodeBase64(item), this.secretKeyB64);
                if (!decryptedString) {
                    results.push(null);
                } else {
                    // Parse JSON string back to object
                    results.push(JSON.parse(decryptedString));
                }
            } catch (error) {
                results.push(null);
            }
        }
        return results;
    }
}