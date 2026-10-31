import type { Principal } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { MobileDeviceRegistry } from './device-registry';
import { adoptCurrentPairedPrincipal } from './gateway/principal-grant';
import { isMobileGatewayMethodAllowedForRole } from './role-methods';

/**
 * The gateway's per-request authorization for a paired device: its current grant from the registry (a revoked or
 * re-paired device fails), and a role that allows the method.
 */
export const createPairedPrincipalGuard = (
    registry: Pick<MobileDeviceRegistry, 'currentPrincipal'>,
) => {
    const currentPairedPrincipal = (principal: Principal, method: string) => {
        if (principal.kind !== 'paired-device')
            throw new CaxriError('FORBIDDEN', 'Paired device principal is required');
        const current = adoptCurrentPairedPrincipal(
            principal,
            registry.currentPrincipal(principal.deviceId, principal.generation),
        );
        if (!current) throw new CaxriError('FORBIDDEN', 'Paired device authorization changed');
        if (!isMobileGatewayMethodAllowedForRole(current.role, method))
            throw new CaxriError('FORBIDDEN', 'Paired device role does not allow this method');
        return current;
    };
    /**
     * Runs a read as the device's current principal and checks the grant again before answering, so a device revoked or
     * demoted during the read gets no result.
     */
    const readAsPaired = async <T>(
        principal: Principal,
        method: string,
        read: (paired: ReturnType<typeof currentPairedPrincipal>) => Promise<T>,
    ): Promise<T> => {
        const paired = currentPairedPrincipal(principal, method);
        const result = await read(paired);
        currentPairedPrincipal(paired, method);
        return result;
    };
    return { currentPairedPrincipal, readAsPaired };
};
