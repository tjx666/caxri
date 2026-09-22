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
export type MobileCredentialIdentity = Pick<
    MobileCredential,
    'credential' | 'deviceId' | 'generation' | 'serverId'
>;

export interface CredentialStorageAdapter {
    deleteItemAsync(key: string): Promise<void>;
    getItemAsync(key: string): Promise<string | null>;
    setItemAsync(key: string, value: string): Promise<void>;
}

export interface MobileCredentialStore {
    clear(): Promise<void>;
    clearIfCurrent(identity: MobileCredentialIdentity): Promise<boolean>;
    load(): Promise<MobileCredential | null>;
    save(credential: MobileCredential): Promise<void>;
    saveIfActive(
        credential: MobileCredential,
        isActive: () => boolean,
    ): Promise<{ previous: MobileCredential | null; saved: boolean }>;
    restoreIfCurrent(
        identity: MobileCredentialIdentity,
        replacement: MobileCredential | null,
    ): Promise<boolean>;
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
    const isMatchingIdentity = (
        current: MobileCredential | null,
        identity: MobileCredentialIdentity,
    ): boolean =>
        current !== null &&
        current.serverId === identity.serverId &&
        current.deviceId === identity.deviceId &&
        current.generation === identity.generation &&
        current.credential === identity.credential;
    return {
        clear: () => serialize(() => storage.deleteItemAsync(MOBILE_CREDENTIAL_KEY)),
        clearIfCurrent: (identity) =>
            serialize(async () => {
                const current = await loadStored();
                if (!isMatchingIdentity(current, identity)) return false;
                await storage.deleteItemAsync(MOBILE_CREDENTIAL_KEY);
                return true;
            }),
        load: () => serialize(loadStored),
        save: (credential) =>
            serialize(async () => {
                const value = mobileCredentialSchema.parse(credential);
                await storage.setItemAsync(MOBILE_CREDENTIAL_KEY, JSON.stringify(value));
            }),
        saveIfActive: (credential, isActive) =>
            serialize(async () => {
                const previous = await loadStored();
                if (!isActive()) return { previous, saved: false };
                const value = mobileCredentialSchema.parse(credential);
                await storage.setItemAsync(MOBILE_CREDENTIAL_KEY, JSON.stringify(value));
                if (isActive()) return { previous, saved: true };

                // Keep the write, active-state check, and cancellation rollback in this one queue slot. A load that was
                // queued while SecureStore was writing must observe the pre-pairing value, never the cancelled one.
                const current = await loadStored();
                if (isMatchingIdentity(current, value)) {
                    if (previous === null) await storage.deleteItemAsync(MOBILE_CREDENTIAL_KEY);
                    else
                        await storage.setItemAsync(MOBILE_CREDENTIAL_KEY, JSON.stringify(previous));
                }
                return { previous, saved: false };
            }),
        restoreIfCurrent: (identity, replacement) =>
            serialize(async () => {
                const current = await loadStored();
                if (!isMatchingIdentity(current, identity)) return false;
                if (replacement === null) await storage.deleteItemAsync(MOBILE_CREDENTIAL_KEY);
                else {
                    const value = mobileCredentialSchema.parse(replacement);
                    await storage.setItemAsync(MOBILE_CREDENTIAL_KEY, JSON.stringify(value));
                }
                return true;
            }),
    };
};
