import { execFileSync } from 'node:child_process';
import type { NetworkInterfaceInfo, NetworkInterfaceInfoIPv4 } from 'node:os';
import { networkInterfaces } from 'node:os';
import process from 'node:process';

import { isPrivateMobileIpv4Address } from '@caxri/mobile-transport';
import { CaxriError } from '@caxri/protocol';

/**
 * Closed reasons an interface is left out of the pairing link.
 */
type MobileInterfaceExclusion = 'virtual-machine-bridge' | 'container-or-vm-interface';

/**
 * Names of interfaces created by container runtimes and hypervisors for guests. Anchored on purpose: `bridge*`, `br0`,
 * `utun*`, `en*`, VPN tunnels and unknown names stay, because a phone may reach them (macOS Internet Sharing uses
 * `bridge100`). VMware `vmnet0` is its bridged mode, so only `vmnet1`/`vmnet8` go.
 */
const GUEST_INTERFACE_NAME =
    /^(?:docker0|docker_gwbridge|br-[0-9a-f]{12}|veth.*|virbr\d+|vboxnet\d+|vnic\d+|lxcbr\d+|lxdbr\d+|incusbr\d+|cni\d+|cni-.*|flannel\..*|podman\d+|vmnet[18])$/u;

/**
 * Decides whether an interface only serves guests. `bridgeMembers` maps a macOS `bridgeN` to its member interfaces; a
 * bridge whose members are all `vmenet*` (virtual NICs of VMs) is a VM bridge, while an Internet Sharing bridge has
 * physical or `ap*` members.
 */
function classifyMobileInterfaceExclusion(
    name: string,
    bridgeMembers: Readonly<Record<string, readonly string[]>> = {},
): MobileInterfaceExclusion | undefined {
    if (GUEST_INTERFACE_NAME.test(name)) return 'container-or-vm-interface';
    const members = bridgeMembers[name] ?? [];
    if (
        /^bridge\d+$/u.test(name) &&
        members.length > 0 &&
        members.every((m) => /^vmenet\d+$/u.test(m))
    )
        return 'virtual-machine-bridge';
    return undefined;
}

/**
 * Reads macOS bridge membership from `ifconfig`; empty elsewhere or on any failure.
 */
function readMacBridgeMembers(): Record<string, string[]> {
    if (process.platform !== 'darwin') return {};
    try {
        // oxlint-disable-next-line node/no-sync -- address selection is synchronous at gateway start; bounded by a 2s timeout.
        const output = execFileSync('/sbin/ifconfig', ['-a'], {
            encoding: 'utf8',
            timeout: 2000,
        });
        const result: Record<string, string[]> = {};
        let current: string | undefined;
        for (const line of output.split('\n')) {
            const header = /^(bridge\d+):/u.exec(line);
            if (header) {
                current = header[1];
                result[current] = [];
            } else if (/^\S/u.test(line)) current = undefined;
            else if (current) {
                const member = /^\s+member: (\S+)/u.exec(line);
                if (member) result[current]?.push(member[1]);
            }
        }
        return result;
    } catch {
        return {};
    }
}

export function selectMobileGatewayAddress(
    interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
    bridgeMembers?: Readonly<Record<string, readonly string[]>>,
): string {
    return selectMobileGatewayAddresses(interfaces, bridgeMembers)[0];
}

export function selectMobileGatewayAddresses(
    interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
    bridgeMembers: Readonly<Record<string, readonly string[]>> = readMacBridgeMembers(),
): string[] {
    const candidates: Array<{ entry: NetworkInterfaceInfoIPv4; name: string }> = [];
    for (const [name, entries] of Object.entries(interfaces)) {
        if (classifyMobileInterfaceExclusion(name, bridgeMembers)) continue;
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
