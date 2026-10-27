import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import type { EnvironmentMonitorAlertEvent } from '../environment-monitor/monitor';
import {
    createEnvironmentMonitor,
    defaultEnvironmentMonitorSignals,
    proxyModeOf,
    timeZoneOffsetMinutes,
} from '../environment-monitor/monitor';
import {
    createLiveEnvironmentMonitorProbe,
    EnvironmentMonitorProbeError,
    environmentMonitorProbeFailureReason,
} from '../environment-monitor/probe';
import type {
    EnvironmentMonitorProbeReading,
    EnvironmentMonitorSignals,
} from '../environment-monitor/types';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const OPTIONAL_SIGNALS: EnvironmentMonitorSignals = {
    publicIpChanges: true,
    proxyProtection: true,
    locationChanges: true,
    timeZoneMismatch: true,
    checkUnavailable: true,
};

function reading(overrides: Partial<EnvironmentMonitorProbeReading> = {}) {
    return {
        egress: {
            ip: '192.0.2.10',
            countryCode: 'US',
            region: 'Example City, Example Region, US',
            network: 'AS64500 Example Network',
            timeZone: 'America/Los_Angeles',
        },
        proxy: { route: 'PROXY proxy.example:443; DIRECT', available: true },
        ...overrides,
    } satisfies EnvironmentMonitorProbeReading;
}

describe('Environment monitor', () => {
    it('defaults to public IP changes and keeps raw network identity out of state', async () => {
        const alerts: EnvironmentMonitorAlertEvent[] = [];
        const probe = vi.fn().mockResolvedValue(reading());
        const monitor = createEnvironmentMonitor({ probe, now: () => NOW });
        monitor.subscribeAlerts((event) => alerts.push(event));

        const state = await monitor.refresh();

        expect(probe).toHaveBeenCalledWith(
            defaultEnvironmentMonitorSignals,
            expect.any(AbortSignal),
        );
        expect(state).toMatchObject({
            state: 'healthy',
            issues: [],
            consecutiveFailures: 0,
            canAcceptBaseline: false,
        });
        expect(state.details).toBeUndefined();
        expect(JSON.stringify(state)).not.toContain('192.0.2.10');
        expect(JSON.stringify(state)).not.toContain('proxy.example');
        expect(alerts).toEqual([]);
    });

    it('ignores disabled location, proxy, and time-zone signals', async () => {
        const probe = vi
            .fn()
            .mockResolvedValueOnce(reading())
            .mockResolvedValue(
                reading({
                    egress: {
                        ...reading().egress,
                        countryCode: 'JP',
                        region: 'Example, Kanto, JP',
                        timeZone: 'Asia/Tokyo',
                    },
                    proxy: { route: 'DIRECT', available: false },
                }),
            );
        const monitor = createEnvironmentMonitor({ probe, now: () => NOW });

        await monitor.refresh();
        const state = await monitor.refresh();

        expect(state).toMatchObject({ state: 'healthy', issues: [] });
        expect(state.details).toBeUndefined();
    });

    it('deduplicates selected changes and keeps a time-zone mismatch after accepting a new baseline', async () => {
        const probe = vi
            .fn()
            .mockResolvedValueOnce(reading())
            .mockResolvedValue(
                reading({
                    egress: {
                        ...reading().egress,
                        ip: '198.51.100.20',
                        countryCode: 'JP',
                        region: 'Example, Kanto, JP',
                        timeZone: 'Asia/Tokyo',
                    },
                    proxy: { route: 'PROXY second.example:443', available: true },
                }),
            );
        const monitor = createEnvironmentMonitor({
            loadSignals: () => Promise.resolve(OPTIONAL_SIGNALS),
            now: () => NOW,
            probe,
            systemTimeZone: () => 'America/Los_Angeles',
        });
        const alerts: EnvironmentMonitorAlertEvent[] = [];
        monitor.subscribeAlerts((event) => alerts.push(event));

        await monitor.refresh();
        const changed = await monitor.refresh();
        await monitor.refresh();

        expect(changed.issues).toEqual([
            'publicIpChanged',
            'locationChanged',
            'proxyRouteChanged',
            'timeZoneMismatch',
        ]);
        expect(alerts).toHaveLength(1);
        expect(monitor.acceptBaseline()).toMatchObject({
            state: 'warning',
            issues: ['timeZoneMismatch'],
            canAcceptBaseline: false,
        });
        expect(alerts).toHaveLength(2);
        expect(alerts.at(-1)).toEqual({ type: 'clear' });
    });

    it('notifies only when an issue is added and clears stale banners after reductions', async () => {
        const signals = {
            ...defaultEnvironmentMonitorSignals,
            proxyProtection: true,
        };
        const proxyAvailable = { route: 'PROXY proxy.example:443', available: true };
        const proxyUnavailable = { route: 'PROXY proxy.example:443', available: false };
        const changedIp = { ...reading().egress, ip: '198.51.100.20' };
        const probe = vi
            .fn()
            .mockResolvedValueOnce(reading({ proxy: proxyAvailable }))
            .mockResolvedValueOnce(reading({ egress: changedIp, proxy: proxyUnavailable }))
            .mockResolvedValueOnce(reading({ egress: changedIp, proxy: proxyAvailable }))
            .mockResolvedValueOnce(reading({ egress: changedIp, proxy: proxyAvailable }))
            .mockResolvedValueOnce(reading({ egress: changedIp, proxy: proxyUnavailable }))
            .mockResolvedValueOnce(reading({ proxy: proxyAvailable }));
        const monitor = createEnvironmentMonitor({
            loadSignals: () => Promise.resolve(signals),
            probe,
        });
        const alerts: EnvironmentMonitorAlertEvent[] = [];
        monitor.subscribeAlerts((event) => alerts.push(event));

        await monitor.refresh();
        await monitor.refresh();
        await monitor.refresh();
        await monitor.refresh();
        await monitor.refresh();
        await monitor.refresh();

        expect(alerts).toHaveLength(4);
        expect(alerts[0]).toMatchObject({
            type: 'show',
            state: { issues: ['publicIpChanged', 'proxyUnavailable'] },
        });
        expect(alerts[1]).toEqual({ type: 'clear' });
        expect(alerts[2]).toMatchObject({
            type: 'show',
            state: { issues: ['publicIpChanged', 'proxyUnavailable'] },
        });
        expect(alerts[3]).toEqual({ type: 'clear' });
    });

    it('reports a selected local proxy interruption without exposing its address', async () => {
        const monitor = createEnvironmentMonitor({
            loadSignals: () =>
                Promise.resolve({
                    ...defaultEnvironmentMonitorSignals,
                    proxyProtection: true,
                }),
            probe: vi
                .fn()
                .mockResolvedValueOnce(reading())
                .mockResolvedValue(
                    reading({ proxy: { route: 'PROXY proxy.example:443', available: false } }),
                ),
        });

        await monitor.refresh();
        const state = await monitor.refresh();

        expect(state.issues).toContain('proxyUnavailable');
        expect(JSON.stringify(state)).not.toContain('proxy.example');
    });

    it('only reports repeated check failures when that signal is enabled', async () => {
        let signals = defaultEnvironmentMonitorSignals;
        const probe = vi.fn().mockRejectedValue(new Error('offline'));
        const monitor = createEnvironmentMonitor({
            failureThreshold: 3,
            loadSignals: () => Promise.resolve(signals),
            probe,
        });

        await monitor.refresh();
        await monitor.refresh();
        expect(await monitor.refresh()).toMatchObject({ state: 'checking', issues: [] });

        signals = { ...signals, checkUnavailable: true };
        expect(await monitor.refresh()).toMatchObject({
            state: 'unavailable',
            issues: ['checkUnavailable'],
            consecutiveFailures: 4,
        });
    });

    it('does not probe when every signal is disabled', async () => {
        const probe = vi.fn();
        const monitor = createEnvironmentMonitor({
            loadSignals: () =>
                Promise.resolve({
                    publicIpChanges: false,
                    proxyProtection: false,
                    locationChanges: false,
                    timeZoneMismatch: false,
                    checkUnavailable: false,
                }),
            probe,
        });

        expect(await monitor.refresh()).toMatchObject({ state: 'disabled', issues: [] });
        expect(probe).not.toHaveBeenCalled();
    });

    it('shares one in-flight refresh', async () => {
        const pending = Promise.withResolvers<EnvironmentMonitorProbeReading>();
        const probe = vi.fn(() => pending.promise);
        const monitor = createEnvironmentMonitor({ probe });

        const first = monitor.refresh();
        const second = monitor.refresh();
        await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
        pending.resolve(reading());

        await expect(first).resolves.toMatchObject({ state: 'healthy' });
        await expect(second).resolves.toMatchObject({ state: 'healthy' });
        expect(probe).toHaveBeenCalledOnce();
    });

    it('logs a closed failure reason and selected signal booleans', async () => {
        const write = vi.fn<StructuredLogger['write']>();
        const monitor = createEnvironmentMonitor({
            logger: () => ({ write }) as never,
            probe: vi
                .fn()
                .mockRejectedValue(
                    new EnvironmentMonitorProbeError(
                        'invalidResponse',
                        'synthetic invalid response',
                    ),
                ),
        });

        await monitor.refresh();

        expect(write).toHaveBeenCalledOnce();
        expect(write.mock.calls[0]?.[0]).toBe('warn');
        expect(write.mock.calls[0]?.[1]).toBe('environment_monitor.probe_failed');
        expect(write.mock.calls[0]?.[2]?.fields).toMatchObject({
            failureReason: 'invalidResponse',
            publicIpChangesEnabled: true,
        });
        expect(
            environmentMonitorProbeFailureReason(
                new EnvironmentMonitorProbeError('redirected', 'synthetic redirect'),
            ),
        ).toBe('redirected');
    });
});

describe('Environment monitor probes', () => {
    it('uses neutral IP-only sources by default and skips proxy resolution', async () => {
        const fetch = vi
            .fn<typeof globalThis.fetch>()
            .mockResolvedValueOnce(Response.json({ ip: 'not-an-ip' }))
            .mockResolvedValueOnce(Response.json({ ip: '203.0.113.3' }));
        const resolveProxy = vi.fn();
        const probe = createLiveEnvironmentMonitorProbe({ fetch, resolveProxy });

        const result = await probe(defaultEnvironmentMonitorSignals, new AbortController().signal);

        expect(result).toEqual({ egress: { ip: '203.0.113.3' } });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(resolveProxy).not.toHaveBeenCalled();
        for (const [url] of fetch.mock.calls) {
            const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
            expect(href).not.toMatch(/anthropic|claude/iu);
        }
        for (const [, init] of fetch.mock.calls) expect(init?.redirect).toBe('error');
    });

    it('tries another source when enabled location fields are incomplete', async () => {
        const fetch = vi
            .fn<typeof globalThis.fetch>()
            .mockResolvedValueOnce(Response.json({ ip: '203.0.113.3' }))
            .mockResolvedValueOnce(
                Response.json({
                    ip: '203.0.113.4',
                    country_code: 'JP',
                    region: 'Example Region',
                    timezone: 'Asia/Tokyo',
                }),
            );
        const probe = createLiveEnvironmentMonitorProbe({ fetch, resolveProxy: vi.fn() });

        await expect(
            probe(
                { ...defaultEnvironmentMonitorSignals, locationChanges: true },
                new AbortController().signal,
            ),
        ).resolves.toMatchObject({ egress: { ip: '203.0.113.4', countryCode: 'JP' } });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('resolves and checks a loopback proxy against the neutral source URL', async () => {
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
            Response.json({
                ip: '203.0.113.3',
                country: 'US',
                city: 'Example',
                region: 'Example Region',
                timezone: 'America/Los_Angeles',
                org: 'AS64501 Example Transit',
            }),
        );
        const resolveProxy = vi.fn().mockResolvedValue('PROXY 127.0.0.1:7890');
        const checkLocalProxy = vi.fn().mockResolvedValue(true);
        const probe = createLiveEnvironmentMonitorProbe({ fetch, resolveProxy, checkLocalProxy });

        const result = await probe(OPTIONAL_SIGNALS, new AbortController().signal);

        expect(resolveProxy).toHaveBeenCalledWith('https://ipinfo.io/json');
        expect(checkLocalProxy).toHaveBeenCalledWith(
            { host: '127.0.0.1', port: 7890 },
            expect.any(AbortSignal),
        );
        expect(result).toMatchObject({
            egress: { ip: '203.0.113.3', countryCode: 'US' },
            proxy: { route: 'PROXY 127.0.0.1:7890', available: true },
        });
    });

    it('returns a local proxy interruption without contacting an external source', async () => {
        const fetch = vi.fn<typeof globalThis.fetch>();
        const probe = createLiveEnvironmentMonitorProbe({
            fetch,
            resolveProxy: vi.fn().mockResolvedValue('PROXY localhost:7890'),
            checkLocalProxy: vi.fn().mockResolvedValue(false),
        });

        await expect(probe(OPTIONAL_SIGNALS, new AbortController().signal)).resolves.toEqual({
            proxy: { route: 'PROXY LOCALHOST:7890', available: false },
        });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects oversized bodies from every neutral source', async () => {
        const fetch = vi
            .fn<typeof globalThis.fetch>()
            .mockImplementation(() =>
                Promise.resolve(new Response(' '.repeat(70 * 1_024), { status: 200 })),
            );
        const probe = createLiveEnvironmentMonitorProbe({ fetch, resolveProxy: vi.fn() });

        await expect(
            probe(defaultEnvironmentMonitorSignals, new AbortController().signal),
        ).rejects.toThrow('size limit');
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('classifies proxy routes and compares current UTC offsets', () => {
        expect(proxyModeOf('DIRECT')).toBe('direct');
        expect(proxyModeOf('PROXY proxy.example:443')).toBe('proxy');
        expect(proxyModeOf('SOCKS5 proxy.example:1080; DIRECT')).toBe('mixed');
        expect(proxyModeOf('')).toBe('unknown');
        expect(timeZoneOffsetMinutes('America/Los_Angeles', NOW)).toBe(
            timeZoneOffsetMinutes('America/Vancouver', NOW),
        );
        expect(timeZoneOffsetMinutes('Asia/Tokyo', NOW)).not.toBe(
            timeZoneOffsetMinutes('America/Los_Angeles', NOW),
        );
    });
});
