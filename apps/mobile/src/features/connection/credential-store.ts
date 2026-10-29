import {
    isPrivateMobileIpv4Address,
    relayHostIdSchema,
    relayUrlSchema,
} from '@caxri/mobile-transport';
import { mobileDeviceIdSchema } from '@caxri/protocol';
import { z } from 'zod';

// oxlint-disable-next-line react-doctor/no-secrets-in-client-code -- This is a native secure-store record name, not a bundled credential.
const MOBILE_CREDENTIAL_KEY = 'caxri.mobile-credential.v1';

const mobileCredentialSchema = z.strictObject({
    version: z.literal(1),
    addresses: z.array(z.ipv4().refine(isPrivateMobileIpv4Address)).min(1).max(8),
    port: z.number().int().min(1).max(65_535),
    serverId: z.string().min(1).max(200),
    deviceId: mobileDeviceIdSchema,
    generation: z.number().int().positive(),
    credential: z.string().regex(/^[0-9a-f]{64}$/u),
    /**
     * The Relay the computer advertised at pairing; absent for computers paired without one.
     */
    relay: z.strictObject({ url: relayUrlSchema, hostId: relayHostIdSchema }).optional(),
});

export type MobileCredential = z.infer<typeof mobileCredentialSchema>;
type MobileCredentialIdentity = Pick<MobileCredential, 'deviceId' | 'generation' | 'serverId'>;

export interface CredentialStorageAdapter {
    deleteItemAsync(key: string): Promise<void>;
    getItemAsync(key: string): Promise<string | null>;
    setItemAsync(key: string, value: string): Promise<void>;
}

export interface MobileCredentialStore {
    clear(): Promise<void>;
    clearIfCurrent(identity: MobileCredentialIdentity): Promise<boolean>;
    load(): Promise<MobileCredential | null>;
    save(credential: MobileCredential, isCurrent?: () => boolean): Promise<void>;
}

/**
 * Invalid or obsolete secure-store values fail closed and are never returned to the connection layer.
 */
export const createMobileCredentialStore = (
    storage: CredentialStorageAdapter,
): MobileCredentialStore => {
    let operationQueue = Promise.resolve();
    /**
     * SecureStore has no compare-and-delete primitive. Serializing reads and mutations prevents an old connection's
     * authenticated revocation from deleting a newer pairing saved while its asynchronous deletion is pending.
     */
    const serialize = <Result>(operation: () => Promise<Result>): Promise<Result> => {
        // eslint-disable-next-line unicorn/prefer-await, unicorn/prefer-then-catch -- Chaining the shared tail provides a mutex without ES2024-only Promise.withResolvers in React Native.
        const result = operationQueue.then(operation, operation);
        // eslint-disable-next-line unicorn/prefer-await, unicorn/prefer-then-catch -- The queue must recover after an operation fails so later credential work is not stranded.
        operationQueue = result.then(
            () => {},
            () => {},
        );
        return result;
    };
    const loadStored = async (): Promise<MobileCredential | null> => {
        const source = await storage.getItemAsync(MOBILE_CREDENTIAL_KEY);
        if (source === null) return null;
        try {
            return mobileCredentialSchema.parse(JSON.parse(source));
        } catch {
            await storage.deleteItemAsync(MOBILE_CREDENTIAL_KEY);
            return null;
        }
    };
    return {
        clear: () => serialize(() => storage.deleteItemAsync(MOBILE_CREDENTIAL_KEY)),
        clearIfCurrent: (identity) =>
            serialize(async () => {
                const current = await loadStored();
                if (
                    !current ||
                    current.serverId !== identity.serverId ||
                    current.deviceId !== identity.deviceId ||
                    current.generation !== identity.generation
                )
                    return false;
                await storage.deleteItemAsync(MOBILE_CREDENTIAL_KEY);
                return true;
            }),
        load: () => serialize(loadStored),
        save: (credential, isCurrent = () => true) =>
            serialize(async () => {
                if (!isCurrent()) throw new Error('Pairing attempt was superseded.');
                const previous = await storage.getItemAsync(MOBILE_CREDENTIAL_KEY);
                if (!isCurrent()) throw new Error('Pairing attempt was superseded.');
                const value = mobileCredentialSchema.parse(credential);
                await storage.setItemAsync(MOBILE_CREDENTIAL_KEY, JSON.stringify(value));
                /**
                 * SecureStore writes cannot be cancelled; rollback stays inside the storage queue.
                 */
                if (!isCurrent()) {
                    if (previous === null) await storage.deleteItemAsync(MOBILE_CREDENTIAL_KEY);
                    else await storage.setItemAsync(MOBILE_CREDENTIAL_KEY, previous);
                    throw new Error('Pairing attempt was superseded.');
                }
            }),
    };
};
