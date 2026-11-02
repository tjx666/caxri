import type { MobileFrameCipher } from '@caxri/mobile-transport';
import { aesDecryptAsync, aesEncryptAsync, AESEncryptionKey, AESSealedData } from 'expo-crypto';

/**
 * A session's two keys are fixed for its lifetime, so each is imported into the native module once.
 */
const importedKeys = new WeakMap<Uint8Array, Promise<AESEncryptionKey>>();

const importKey = (key: Uint8Array): Promise<AESEncryptionKey> => {
    let imported = importedKeys.get(key);
    if (!imported) {
        imported = AESEncryptionKey.import(key);
        importedKeys.set(key, imported);
    }
    return imported;
};

/**
 * Seals and opens frames with the platform's native AES-GCM through `expo-crypto`, about 30 times faster than the
 * pure-JS cipher under Hermes for a 24 KiB Terminal frame (#3431).
 */
export const expoFrameCipher: MobileFrameCipher = {
    open: async (key, nonce, additionalData, ciphertext) =>
        aesDecryptAsync(AESSealedData.fromParts(nonce, ciphertext), await importKey(key), {
            additionalData,
        }),
    seal: async (key, nonce, additionalData, plaintext) => {
        const sealed = await aesEncryptAsync(plaintext, await importKey(key), {
            additionalData,
            nonce: { bytes: nonce },
        });
        return sealed.ciphertext({ includeTag: true });
    },
};
