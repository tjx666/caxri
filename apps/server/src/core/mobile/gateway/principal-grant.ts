import type { Principal } from '@caxri/protocol';

type PairedPrincipal = Extract<Principal, { kind: 'paired-device' }>;

/**
 * Checks a principal cached at connection time against the registry's current one. A Project added from the phone is
 * granted mid-connection, so a longer Project list is adopted; any removal, role, or identity change is not.
 */
export const adoptCurrentPairedPrincipal = (
    cached: Principal | undefined,
    current: Principal,
): PairedPrincipal | undefined => {
    if (
        cached?.kind !== 'paired-device' ||
        current.kind !== 'paired-device' ||
        current.id !== cached.id ||
        current.role !== cached.role
    )
        return undefined;
    const granted = new Set(current.projectIds);
    return cached.projectIds.every((projectId) => granted.has(projectId)) ? current : undefined;
};
