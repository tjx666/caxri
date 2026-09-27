import type { CommandAdapter, Principal } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { MobileDeviceRegistry } from '../device-registry';

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

/**
 * Re-reads the paired device's principal from the registry on every dispatch, so a request never runs with a Project
 * list, role, or generation that changed after its connection authenticated.
 */
export const currentPrincipalAdapter = (
    server: CommandAdapter,
    registry: Pick<MobileDeviceRegistry, 'currentPrincipal'>,
): CommandAdapter => ({
    invoke: (request, context, invocation) => {
        if (context.principal.kind !== 'paired-device')
            throw new CaxriError('FORBIDDEN', 'Paired device principal is required');
        const principal = registry.currentPrincipal(
            context.principal.deviceId,
            context.principal.generation,
        );
        return server.invoke(request, { ...context, principal }, invocation);
    },
    isAvailable: () => server.isAvailable?.() !== false,
});
