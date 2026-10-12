import type { AgentProviderStatus } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    describeProviderStatus,
    incidentPhaseLabel,
    isProviderStatusDisrupted,
    providerStatusFailureLabel,
    providerStatusView,
    summarizeIncidents,
} from '../agent-provider-status-label';

type AvailableStatus = Extract<AgentProviderStatus, { state: 'available' }>;

function available(components: AvailableStatus['components'], status: AvailableStatus['status']) {
    return {
        provider: 'codex',
        pageName: 'OpenAI',
        pageUrl: 'https://status.example.test',
        checkedAt: 0,
        state: 'available',
        status,
        components,
        incidents: [],
    } satisfies AvailableStatus;
}

describe('describeProviderStatus', () => {
    it('reads one word while every component is operational', () => {
        expect(
            describeProviderStatus(
                available(
                    [
                        { name: 'Codex API', status: 'operational' },
                        { name: 'CLI', status: 'operational' },
                    ],
                    'operational',
                ),
            ),
        ).toBe('Operational');
    });

    it('names the worst status and every component that is not operational', () => {
        expect(
            describeProviderStatus(
                available(
                    [
                        { name: 'Codex Web', status: 'operational' },
                        { name: 'Codex API', status: 'degraded' },
                        { name: 'CLI', status: 'partialOutage' },
                    ],
                    'partialOutage',
                ),
            ),
        ).toBe('Partial outage: Codex API, CLI');
    });
});

describe('providerStatusFailureLabel', () => {
    it('says why the status is missing', () => {
        expect(providerStatusFailureLabel('network')).toBe(
            'Status unavailable: the status page could not be reached',
        );
    });
});

describe('incident lines', () => {
    it('capitalizes the phase the same way on the card and the tab', () => {
        expect(incidentPhaseLabel('identified')).toBe('Identified');
    });

    it('keeps the first incident and counts the rest', () => {
        expect(summarizeIncidents([])).toEqual({ first: undefined, moreLabel: undefined });
        expect(summarizeIncidents(['a'])).toEqual({ first: 'a', moreLabel: undefined });
        expect(summarizeIncidents(['a', 'b', 'c'])).toEqual({ first: 'a', moreLabel: '+2 more' });
    });
});

describe('isProviderStatusDisrupted', () => {
    it('is true only for a readable status page reporting a problem', () => {
        expect(isProviderStatusDisrupted(available([], 'degraded'))).toBe(true);
        expect(isProviderStatusDisrupted(available([], 'operational'))).toBe(false);
        expect(isProviderStatusDisrupted(undefined)).toBe(false);
        expect(isProviderStatusDisrupted(null)).toBe(false);
        expect(
            isProviderStatusDisrupted({
                provider: 'codex',
                pageName: 'OpenAI',
                pageUrl: 'https://status.example.test',
                checkedAt: 0,
                state: 'unavailable',
                reason: 'network',
            }),
        ).toBe(false);
    });
});

describe('providerStatusView', () => {
    it('offers a retry when the first read failed, and keeps a reading through a failed refresh', () => {
        expect(providerStatusView(undefined, false)).toBe('checking');
        expect(providerStatusView(undefined, true)).toBe('failed');
        expect(providerStatusView(null, true)).toBe('none');
        expect(providerStatusView(available([], 'operational'), true)).toBe('ready');
    });
});
