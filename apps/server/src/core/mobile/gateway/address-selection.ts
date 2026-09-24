import type { NetworkInterfaceInfo, NetworkInterfaceInfoIPv4 } from 'node:os';
import { networkInterfaces } from 'node:os';

import { isPrivateMobileIpv4Address } from '@caxri/mobile-transport';
import { CaxriError } from '@caxri/protocol';

export function selectMobileGatewayAddress(
    interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string {
    return selectMobileGatewayAddresses(interfaces)[0];
}

export function selectMobileGatewayAddresses(
    interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string[] {
    const candidates: Array<{ entry: NetworkInterfaceInfoIPv4; name: string }> = [];
    for (const [name, entries] of Object.entries(interfaces)) {
        const networkEntries = entries ?? [];
        for (const entry of networkEntries)
            if (
                entry.family === 'IPv4' &&
                !entry.internal &&
                isPrivateMobileIpv4Address(entry.address)
            )
                candidates.push({ entry, name });
    }
    candidates.sort((left, right) => {
        const tailscale = (address: string): number => (address.startsWith('100.') ? 0 : 1);
        /**
         * Tailscale survives Wi-Fi changes; otherwise prefer physical `enN` interfaces before address ordering.
         */
        const physical = (name: string): number => (/^en\d+$/u.test(name) ? 0 : 1);
        return (
            tailscale(left.entry.address) - tailscale(right.entry.address) ||
            physical(left.name) - physical(right.name) ||
            left.name.localeCompare(right.name, 'en', { numeric: true }) ||
            left.entry.address.localeCompare(right.entry.address, 'en', { numeric: true })
        );
    });
    const addresses = candidates.map(({ entry }) => entry.address);
    const address = addresses[0];
    if (!address)
        throw new CaxriError(
            'UNAVAILABLE',
            'No private IPv4 network is available for mobile access',
        );
    return addresses.slice(0, 8);
}
