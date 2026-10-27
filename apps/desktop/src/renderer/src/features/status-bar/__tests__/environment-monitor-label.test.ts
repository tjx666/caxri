import type { EnvironmentMonitorState } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { environmentMonitorChipCopy } from '../environment-monitor-label';

function state(overrides: Partial<EnvironmentMonitorState> = {}): EnvironmentMonitorState {
    return {
        state: 'warning',
        issues: ['publicIpChanged'],
        consecutiveFailures: 0,
        canAcceptBaseline: true,
        details: {
            countryCode: 'US',
            region: 'Example City, Example Region, US',
            network: 'AS64500 Example Network',
            egressTimeZone: 'America/Los_Angeles',
            systemTimeZone: 'Asia/Tokyo',
            proxyMode: 'mixed',
        },
        ...overrides,
    };
}

describe('Environment monitor chip copy', () => {
    it('hides disabled, healthy, and checking states', () => {
        expect(
            environmentMonitorChipCopy(state({ state: 'disabled', issues: [] }), '12:00'),
        ).toBeUndefined();
        expect(
            environmentMonitorChipCopy(state({ state: 'healthy', issues: [] }), '12:00'),
        ).toBeUndefined();
        expect(
            environmentMonitorChipCopy(state({ state: 'checking', issues: [] }), undefined),
        ).toBeUndefined();
    });

    it('names every issue and the sanitized environment facts', () => {
        const copy = environmentMonitorChipCopy(
            state({ issues: ['publicIpChanged', 'proxyRouteChanged', 'timeZoneMismatch'] }),
            '12:00:00 PM',
        );

        expect(copy).toMatchObject({
            label: 'Environment · 3',
            issueLabels: [
                'The public IP changed',
                'The proxy route changed',
                'The system and egress time zones have different UTC offsets',
            ],
        });
        expect(copy?.tooltip.rows).toEqual(
            expect.arrayContaining([
                { label: 'Egress region', value: 'Example City, Example Region, US' },
                { label: 'Proxy route', value: 'Proxy with direct fallback' },
                { label: 'Last checked', value: '12:00:00 PM' },
            ]),
        );
    });

    it('uses a distinct unavailable label', () => {
        expect(
            environmentMonitorChipCopy(
                state({
                    state: 'unavailable',
                    issues: ['checkUnavailable'],
                    canAcceptBaseline: false,
                }),
                '12:00',
            )?.label,
        ).toBe('Environment check unavailable');
    });
});
