import type { MobileCredential, MobileCredentialStore } from './credential-store';

export type CredentialLoadResult =
    { kind: 'loaded'; credential: MobileCredential | null } | { kind: 'storage-error' };

/**
 * A rejected native storage read must stay distinct from an empty, valid store.
 */
export const loadMobileCredential = async (
    store: Pick<MobileCredentialStore, 'load'>,
): Promise<CredentialLoadResult> => {
    try {
        return { kind: 'loaded', credential: await store.load() };
    } catch {
        return { kind: 'storage-error' };
    }
};

/**
 * Loads the stored pairing when the app starts and, when there is none, deletes the read cache. Revoke and forget clear
 * the cache while the app runs, but the system can end the app after the credential is gone and before that clear
 * happens; the next start is then the only place left to remove the forgotten computer's saved content. A storage error
 * proves nothing about the pairing, so it keeps the cache.
 */
export const loadMobileCredentialAtStart = async (
    store: Pick<MobileCredentialStore, 'load'>,
    readCache: { clear(): void },
): Promise<CredentialLoadResult> => {
    const result = await loadMobileCredential(store);
    if (result.kind === 'loaded' && result.credential === null) readCache.clear();
    return result;
};
