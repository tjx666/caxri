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
