import type { AgentProviderStatus } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    describeProviderStatus,
    incidentPhaseLabel,
    providerStatusAlert,
    providerStatusDotClassName,
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

describe('providerStatusAlert', () => {
    it('raises no dot while the provider is operational', () => {
        expect(providerStatusAlert(available([], 'operational'))).toBeUndefined();
    });

    it('warns for maintenance and degraded performance', () => {
        expect(providerStatusAlert(available([], 'maintenance'))).toEqual({
            label: 'API status: Under maintenance',
            tone: 'warning',
        });
        expect(providerStatusAlert(available([], 'degraded'))).toEqual({
            label: 'API status: Degraded performance',
            tone: 'warning',
        });
    });

    it('flags a partial or major outage as danger', () => {
        expect(providerStatusAlert(available([], 'partialOutage'))).toEqual({
            label: 'API status: Partial outage',
            tone: 'danger',
        });
        expect(providerStatusAlert(available([], 'majorOutage'))).toEqual({
            label: 'API status: Major outage',
            tone: 'danger',
        });
    });

    it('stays quiet when there is no reading to trust', () => {
        // Pending first read, no public status page, and an unreadable page: none of them is evidence of an incident.
        expect(providerStatusAlert(undefined)).toBeUndefined();
        expect(providerStatusAlert(null)).toBeUndefined();
        expect(
            providerStatusAlert({
                provider: 'codex',
                pageName: 'OpenAI',
                pageUrl: 'https://status.example.test',
                checkedAt: 0,
                state: 'unavailable',
                reason: 'network',
            }),
        ).toBeUndefined();
    });

    it('shares its tone with the Agent status tab dots', () => {
        expect(providerStatusDotClassName('operational')).toBe('bg-success');
        expect(providerStatusDotClassName('degraded')).toBe('bg-warning');
        expect(providerStatusDotClassName('majorOutage')).toBe('bg-danger');
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

describe('providerStatusView', () => {
    it('offers a retry when the first read failed, and keeps a reading through a failed refresh', () => {
        expect(providerStatusView(undefined, false)).toBe('checking');
        expect(providerStatusView(undefined, true)).toBe('failed');
        expect(providerStatusView(null, true)).toBe('none');
        expect(providerStatusView(available([], 'operational'), true)).toBe('ready');
    });
});
