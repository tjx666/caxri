import { mobileDeviceIdSchema } from '@caxri/protocol';
import { z } from 'zod';

// oxlint-disable-next-line react-doctor/no-secrets-in-client-code -- This is a native secure-store record name, not a bundled credential.
const MOBILE_CREDENTIAL_KEY = 'caxri.mobile-credential.v1';

const mobileCredentialSchema = z.strictObject({
    version: z.literal(1),
    addresses: z.array(z.ipv4()).min(1).max(8),
    port: z.number().int().min(1).max(65_535),
    serverId: z.string().min(1).max(200),
    deviceId: mobileDeviceIdSchema,
    generation: z.number().int().positive(),
    credential: z.string().regex(/^[0-9a-f]{64}$/u),
});

export type MobileCredential = z.infer<typeof mobileCredentialSchema>;

export interface CredentialStorageAdapter {
    deleteItemAsync(key: string): Promise<void>;
    getItemAsync(key: string): Promise<string | null>;
    setItemAsync(key: string, value: string): Promise<void>;
}

export interface MobileCredentialStore {
    clear(): Promise<void>;
    load(): Promise<MobileCredential | null>;
    save(credential: MobileCredential): Promise<void>;
}

/**
 * Invalid or obsolete secure-store values fail closed and are never returned to the connection layer.
 */
export const createMobileCredentialStore = (
    storage: CredentialStorageAdapter,
): MobileCredentialStore => ({
    clear: () => storage.deleteItemAsync(MOBILE_CREDENTIAL_KEY),
    load: async () => {
        const source = await storage.getItemAsync(MOBILE_CREDENTIAL_KEY);
        if (source === null) return null;
        try {
            return mobileCredentialSchema.parse(JSON.parse(source));
        } catch {
            await storage.deleteItemAsync(MOBILE_CREDENTIAL_KEY);
            return null;
        }
    },
    save: async (credential) => {
        const value = mobileCredentialSchema.parse(credential);
        await storage.setItemAsync(MOBILE_CREDENTIAL_KEY, JSON.stringify(value));
    },
});
