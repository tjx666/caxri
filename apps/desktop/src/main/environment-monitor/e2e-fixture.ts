import type { EnvironmentMonitorIpProfile } from '@caxri/protocol';

export interface EnvironmentMonitorE2EFetchers {
    fetchPublicIp(): Promise<string>;
    fetchPublicIpProfile(ip: string, checkedAt: number): Promise<EnvironmentMonitorIpProfile>;
}

/**
 * Keeps Electron E2E offline and gives the environment page one bounded synthetic change scenario. The fixture is
 * reachable only from a `CAXRI_E2E=1` composition root; production launches always use the real fixed endpoints.
 */
export function createEnvironmentMonitorE2EFixture(
    scenario: string | undefined,
): EnvironmentMonitorE2EFetchers {
    let reads = 0;
    return {
        fetchPublicIp: () => {
            reads += 1;
            return Promise.resolve(
                scenario?.startsWith('changed') && reads > 1 ? '203.0.113.11' : '203.0.113.10',
            );
        },
        fetchPublicIpProfile: (ip, checkedAt) => {
            if (scenario === 'changed-profile-unavailable')
                return Promise.reject(new Error('synthetic unavailable profile'));
            return Promise.resolve({
                status: 'available',
                source: 'checkip.me',
                checkedAt,
                country: ip.endsWith('.11') ? 'Singapore' : 'United States',
                countryCode: ip.endsWith('.11') ? 'SG' : 'US',
                region: ip.endsWith('.11') ? 'Singapore' : 'California',
                city: ip.endsWith('.11') ? 'Singapore' : 'Los Angeles',
                asn: ip.endsWith('.11') ? 'AS64511' : 'AS64510',
                isp: ip.endsWith('.11') ? 'Example Hosting' : 'Example ISP',
                organization: ip.endsWith('.11') ? 'Example Cloud' : 'Example Broadband',
                networkType: ip.endsWith('.11') ? 'Hosting' : 'Residential',
                riskScore: ip.endsWith('.11') ? 65 : 10,
                signals: {
                    anonymous: ip.endsWith('.11'),
                    compromised: false,
                    hosting: ip.endsWith('.11'),
                    proxy: false,
                    scraper: false,
                    tor: false,
                    vpn: false,
                },
            });
        },
    };
}
