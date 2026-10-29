import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

import { isPrivateMobileIpv4Address } from '@caxri/mobile-transport';

import type { MobileGatewayFailureReason } from './diagnostics';
import { isAllowedMobileOrigin } from './origin';

export const MAXIMUM_MOBILE_CONNECTIONS = 32;
const MAXIMUM_HANDSHAKES = 8;

export const isAllowedMobilePeer = (remote?: string, local?: string): boolean =>
    isPrivateMobileIpv4Address(remote ?? '') && isPrivateMobileIpv4Address(local ?? '');

function mobileTcpAdmissionFailure(
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

/**
 * Admits one raw TCP connection to the gateway listener, tracking it until it closes and bounding its idle time. A
 * non-private peer, a full listener, or a source over its attempt budget is refused and destroyed.
 */
export function admitMobileTcpConnection(
    socket: Socket,
    options: {
        canAdmitSource: () => boolean;
        onRejected: (reason: MobileGatewayFailureReason) => void;
        remoteAddress: string | undefined;
        sockets: Set<Socket>;
        timeoutMs: number;
    },
): void {
    const { remoteAddress, sockets } = options;
    const rejection = mobileTcpAdmissionFailure(
        remoteAddress,
        socket.localAddress,
        sockets.size,
        options.canAdmitSource,
    );
    if (rejection) {
        options.onRejected(rejection);
        socket.destroy();
        return;
    }
    sockets.add(socket);
    socket.setTimeout(options.timeoutMs, () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
}

/**
 * Shared socket budget for LAN upgrades and Relay dial-backs, so a relayed phone cannot exceed the LAN limits.
 */
export const hasMobileSocketCapacity = (connections: number, handshakes: number): boolean =>
    connections < MAXIMUM_MOBILE_CONNECTIONS && handshakes < MAXIMUM_HANDSHAKES;

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
    if (!hasMobileSocketCapacity(connections, handshakes)) return 'upgradeCapacity';
    return undefined;
}
