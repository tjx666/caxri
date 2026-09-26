import type { IncomingMessage } from 'node:http';

import { isPrivateMobileIpv4Address } from '@caxri/mobile-transport';

import type { MobileGatewayFailureReason } from './diagnostics';
import { isAllowedMobileOrigin } from './origin';

export const MAXIMUM_MOBILE_CONNECTIONS = 32;
const MAXIMUM_HANDSHAKES = 8;

export const isAllowedMobilePeer = (remote?: string, local?: string): boolean =>
    isPrivateMobileIpv4Address(remote ?? '') && isPrivateMobileIpv4Address(local ?? '');

export function mobileTcpAdmissionFailure(
    remoteAddress: string | undefined,
    localAddress: string | undefined,
    connections: number,
    canAdmitSource: () => boolean,
): MobileGatewayFailureReason | undefined {
    if (!isAllowedMobilePeer(remoteAddress, localAddress)) return 'admissionAddress';
    if (connections >= MAXIMUM_MOBILE_CONNECTIONS) return 'admissionCapacity';
    if (!canAdmitSource()) return 'admissionRate';
    return undefined;
}

export function mobileUpgradeFailure(
    request: IncomingMessage,
    remoteAddress: string | undefined,
    connections: number,
    handshakes: number,
): MobileGatewayFailureReason | undefined {
    if (
        request.url !== '/mobile' ||
        !isAllowedMobilePeer(remoteAddress, request.socket.localAddress) ||
        !isAllowedMobileOrigin(request.headers.origin, request.headers.host)
    )
        return 'upgradeRequest';
    if (connections >= MAXIMUM_MOBILE_CONNECTIONS || handshakes >= MAXIMUM_HANDSHAKES)
        return 'upgradeCapacity';
    return undefined;
}
