import type { Principal } from '@caxri/protocol';

import type { MobileDeviceRegistry } from '../device-registry';
import { adoptCurrentPairedPrincipal } from './principal-grant';

interface RecipientSession {
    deviceId: string;
    generation: number;
    principal?: Principal;
    revoking?: boolean;
    valid: boolean;
}

function isEligibleRecipient(
    session: RecipientSession,
    registry: Pick<MobileDeviceRegistry, 'currentPrincipal'>,
    projectId: string,
): boolean {
    if (!session.valid || session.revoking) return false;
    try {
        const current = registry.currentPrincipal(session.deviceId, session.generation);
        const principal = adoptCurrentPairedPrincipal(session.principal, current);
        return principal?.role === 'control' && principal.projectIds.includes(projectId);
    } catch {
        return false;
    }
}

export function hasMobileAttentionRecipient<Socket, Session extends RecipientSession>(
    activeByDevice: Iterable<ReadonlyMap<Socket, Session>>,
    registry: Pick<MobileDeviceRegistry, 'currentPrincipal'>,
    projectId: string,
): boolean {
    for (const sockets of activeByDevice)
        for (const session of sockets.values())
            if (isEligibleRecipient(session, registry, projectId)) return true;
    return false;
}
