import type { EnvironmentMonitorState } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    environmentChanges,
    locationDetailLabel,
    locationLabel,
} from './environment-monitor-presentation';

function stateWithProfiles(
    currentProfile: NonNullable<EnvironmentMonitorState['publicIp']>['current']['profile'],
): EnvironmentMonitorState {
    return {
        state: 'warning',
        issues: [{ kind: 'publicIpChanged' }],
        canUseCurrentIp: true,
        checkedAt: 2,
        publicIp: {
            baseline: {
                address: '203.0.113.10',
                family: 4,
                observedAt: 1,
                profile: {
                    status: 'available',
                    source: 'checkip.me',
                    checkedAt: 1,
                    country: 'United States',
                    city: 'Los Angeles',
                    asn: 'AS64510',
                    isp: 'Example ISP',
                    networkType: 'Residential',
                    operator: 'Example Home Network',
                    riskScore: 10,
                    signals: { anonymous: false, hosting: false, vpn: false },
                },
            },
            current: {
                address: '203.0.113.11',
                family: 4,
                observedAt: 2,
                profile: currentProfile,
            },
        },
        timeZone: { actual: 'Asia/Shanghai', expected: null },
        mihomo: { status: 'off', routes: [] },
    };
}

describe('environmentChanges', () => {
    it('reports exact exit and provider field changes separately', () => {
        const state = stateWithProfiles({
            status: 'available',
            source: 'checkip.me',
            checkedAt: 2,
            country: 'Singapore',
            city: 'Singapore',
            asn: 'AS64511',
            isp: 'Example Hosting',
            networkType: 'Hosting',
            operator: 'Example Cloud Network',
            riskScore: 65,
            signals: { anonymous: true, hosting: true, vpn: false },
        });

        expect(environmentChanges(state)).toEqual([
            { field: 'publicIp', previous: '203.0.113.10', current: '203.0.113.11' },
            { field: 'country', previous: 'United States', current: 'Singapore' },
            { field: 'city', previous: 'Los Angeles', current: 'Singapore' },
            { field: 'asn', previous: 'AS64510', current: 'AS64511' },
            { field: 'isp', previous: 'Example ISP', current: 'Example Hosting' },
            { field: 'networkType', previous: 'Residential', current: 'Hosting' },
            {
                field: 'operator',
                previous: 'Example Home Network',
                current: 'Example Cloud Network',
            },
            { field: 'riskScore', previous: 10, current: 65 },
            { field: 'anonymous', previous: false, current: true },
            { field: 'hosting', previous: false, current: true },
        ]);
    });

    it('does not present unavailable third-party context as a changed field', () => {
        const state = stateWithProfiles({
            status: 'unavailable',
            source: 'checkip.me',
            checkedAt: 2,
        });

        expect(environmentChanges(state)).toEqual([
            { field: 'publicIp', previous: '203.0.113.10', current: '203.0.113.11' },
        ]);
    });
});

describe('location labels', () => {
    it('keeps the city primary and moves the complete region and country into detail', () => {
        const profile = {
            status: 'available',
            source: 'checkip.me',
            checkedAt: 2,
            city: 'Los Angeles',
            region: 'California',
            country: 'United States',
            countryCode: 'US',
            signals: {},
        } as const;

        expect(locationLabel(profile)).toBe('Los Angeles');
        expect(locationDetailLabel(profile)).toBe('California · United States · US');
    });

    it('does not repeat the same city, region, and country label', () => {
        const profile = {
            status: 'available',
            source: 'checkip.me',
            checkedAt: 2,
            city: 'Singapore',
            region: 'Singapore',
            country: 'Singapore',
            countryCode: 'SG',
            signals: {},
        } as const;

        expect(locationLabel(profile)).toBe('Singapore');
        expect(locationDetailLabel(profile)).toBe('SG');
    });
});
