import type { NetworkInterfaceInfo } from 'node:os';

import { describe, expect, it } from 'vitest';

import { selectMobileGatewayAddresses } from '../address-selection';

function v4(address: string): NetworkInterfaceInfo {
    return {
        address,
        cidr: `${address}/24`,
        family: 'IPv4',
        internal: false,
        mac: '00:00:00:00:00:00',
        netmask: '255.255.255.0',
    };
}

describe('selectMobileGatewayAddresses', () => {
    it('omits a macOS bridge whose members are all vmenet interfaces', () => {
        const addresses = selectMobileGatewayAddresses(
            { bridge100: [v4('192.168.64.1')], en0: [v4('192.168.7.20')] },
            { bridge100: ['vmenet0', 'vmenet1'] },
        );
        expect(addresses).toEqual(['192.168.7.20']);
    });

    it('keeps an Internet Sharing bridge with physical members', () => {
        const addresses = selectMobileGatewayAddresses(
            { bridge100: [v4('192.168.2.1')], en0: [v4('192.168.7.20')] },
            { bridge100: ['en5', 'ap1'] },
        );
        expect(addresses).toContain('192.168.2.1');
    });

    it('keeps a bridge whose membership is unknown', () => {
        expect(selectMobileGatewayAddresses({ bridge100: [v4('192.168.2.1')] }, {})).toEqual([
            '192.168.2.1',
        ]);
    });

    it('omits container and hypervisor guest interfaces by name', () => {
        const interfaces = Object.fromEntries(
            ['docker0', 'br-0123456789ab', 'veth1a2b', 'virbr0', 'vboxnet0', 'vnic0', 'vmnet8'].map(
                (name, index) => [name, [v4(`10.0.${index}.1`)]],
            ),
        );
        interfaces.en0 = [v4('192.168.7.20')];
        expect(selectMobileGatewayAddresses(interfaces, {})).toEqual(['192.168.7.20']);
    });

    it('keeps Tailscale, Wi-Fi, and bridged VMware addresses, Tailscale first', () => {
        const addresses = selectMobileGatewayAddresses(
            {
                en0: [v4('192.168.7.20')],
                utun4: [v4('100.64.0.9')],
                vmnet0: [v4('192.168.9.5')],
            },
            {},
        );
        expect(addresses).toEqual(['100.64.0.9', '192.168.7.20', '192.168.9.5']);
    });
});
