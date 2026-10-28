import type { AppSettings, EnvironmentMonitorMihomoSettings } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createEnvironmentMonitor, readPublicIp } from '../environment-monitor/environment-monitor';
import type { MihomoConnectionObservation } from '../environment-monitor/mihomo-controller';
import type { AgentNotificationDelivery } from '../notifications/agent-notification-delivery';

type MonitorSettings = Pick<
    AppSettings,
    | 'environmentMonitor.publicIpChanges'
    | 'environmentMonitor.expectedTimeZone'
    | 'environmentMonitor.mihomoRoutes'
>;

const defaultMihomo: EnvironmentMonitorMihomoSettings = {
    endpoint: 'http://127.0.0.1:9090',
    secret: null,
    assertions: [],
};

function settings(overrides: Partial<MonitorSettings> = {}): MonitorSettings {
    return {
        'environmentMonitor.publicIpChanges': true,
        'environmentMonitor.expectedTimeZone': null,
        'environmentMonitor.mihomoRoutes': defaultMihomo,
        ...overrides,
    };
}

function createTest(options?: {
    settings?: MonitorSettings;
    ips?: string[];
    connections?: MihomoConnectionObservation[];
    timeZone?: string;
}) {
    let currentSettings = options?.settings ?? settings();
    let connections = options?.connections ?? [];
    const ips = [...(options?.ips ?? ['203.0.113.10'])];
    const fetchPublicIp = vi.fn(() => Promise.resolve(ips.shift() ?? '203.0.113.10'));
    const loadSettings = vi.fn(() => Promise.resolve(currentSettings));
    const show = vi.fn(() => ({ close: vi.fn() }));
    const readConnections = vi.fn((): Promise<MihomoConnectionObservation[]> =>
        Promise.resolve(connections),
    );
    const monitor = createEnvironmentMonitor({
        clearInterval: vi.fn(),
        delivery: { show } satisfies AgentNotificationDelivery,
        fetchPublicIp,
        focusMainWindow: vi.fn(() => Promise.resolve()),
        getSystemTimeZone: () => options?.timeZone ?? 'Asia/Shanghai',
        loadSettings,
        now: () => Date.parse('2026-10-28T03:00:00.000Z'),
        readConnections,
        readNodes: vi.fn(() => Promise.resolve(['Node A', 'Node B'])),
        setInterval: vi.fn(() => 1) as unknown as typeof globalThis.setInterval,
    });
    return {
        monitor,
        fetchPublicIp,
        loadSettings,
        readConnections,
        setConnections: (next: MihomoConnectionObservation[]) => {
            connections = next;
        },
        setSettings: (next: MonitorSettings) => {
            currentSettings = next;
        },
        show,
    };
}

describe('environment monitor', () => {
    it('reads the public IP from a neutral endpoint and validates the response', async () => {
        const fetcher = vi.fn(() =>
            Promise.resolve(
                Response.json(
                    { ip: '203.0.113.20' },
                    {
                        headers: { 'Content-Type': 'application/json' },
                        status: 200,
                    },
                ),
            ),
        );

        await expect(readPublicIp(fetcher)).resolves.toBe('203.0.113.20');
        expect(fetcher).toHaveBeenCalledWith(
            'https://api.ipify.org?format=json',
            expect.objectContaining({ headers: { Accept: 'application/json' } }),
        );
    });

    it('uses the first public IP as the launch baseline and warns only after it changes', async () => {
        const test = createTest({ ips: ['203.0.113.10', '203.0.113.11'] });
        await test.monitor.initialize();
        expect(test.monitor.read()).toMatchObject({ state: 'healthy', issues: [] });

        await test.monitor.checkNow();

        expect(test.monitor.read()).toMatchObject({
            state: 'warning',
            issues: [{ kind: 'publicIpChanged' }],
            canUseCurrentIp: true,
        });
        expect(test.show).toHaveBeenCalledTimes(1);
        expect(test.monitor.useCurrentIp()).toMatchObject({
            state: 'healthy',
            issues: [],
            canUseCurrentIp: false,
        });
    });

    it('does not bypass the public IP interval when unrelated settings change', async () => {
        const test = createTest({ ips: ['203.0.113.10', '203.0.113.11'] });
        await test.monitor.initialize();

        test.monitor.observe({ event: 'settings.changed', payload: { source: '{}' } });
        await vi.waitFor(() => expect(test.loadSettings).toHaveBeenCalledTimes(2));

        expect(test.fetchPublicIp).toHaveBeenCalledTimes(1);
        expect(test.monitor.read()).toMatchObject({ state: 'healthy', issues: [] });
    });

    it('checks only a selected system time zone and never derives one from the IP', async () => {
        const test = createTest({
            settings: settings({
                'environmentMonitor.publicIpChanges': false,
                'environmentMonitor.expectedTimeZone': 'America/Los_Angeles',
            }),
            timeZone: 'Asia/Shanghai',
        });

        await test.monitor.initialize();

        expect(test.monitor.read()).toMatchObject({
            state: 'warning',
            issues: [
                {
                    kind: 'timeZoneMismatch',
                    expectedTimeZone: 'America/Los_Angeles',
                    actualTimeZone: 'Asia/Shanghai',
                },
            ],
        });
    });

    it('does not access Mihomo until an assertion exists and treats Controller failures as no new evidence', async () => {
        const test = createTest({
            settings: settings({ 'environmentMonitor.publicIpChanges': false }),
        });
        await test.monitor.initialize();
        expect(test.readConnections).not.toHaveBeenCalled();

        test.setSettings(
            settings({
                'environmentMonitor.publicIpChanges': false,
                'environmentMonitor.mihomoRoutes': {
                    ...defaultMihomo,
                    assertions: [{ domain: 'example.com', expectedNode: 'Node A' }],
                },
            }),
        );
        test.readConnections.mockRejectedValueOnce(new Error('offline'));
        await test.monitor.checkNow();

        expect(test.monitor.read()).toMatchObject({ state: 'healthy', issues: [] });
        expect(test.show).not.toHaveBeenCalled();
    });

    it('warns from the latest real connection and clears after a later expected route', async () => {
        const routeSettings = settings({
            'environmentMonitor.publicIpChanges': false,
            'environmentMonitor.mihomoRoutes': {
                ...defaultMihomo,
                assertions: [{ domain: 'example.com', expectedNode: 'Node A' }],
            },
        });
        const test = createTest({ settings: routeSettings });
        test.setConnections([
            { host: 'example.com', chains: ['Node A', 'Global'], startedAt: 50 },
            { host: 'example.com', chains: ['Node B', 'Global'], startedAt: 100 },
        ]);
        await test.monitor.initialize();

        expect(test.monitor.read()).toMatchObject({
            state: 'warning',
            issues: [
                {
                    kind: 'routeNodeMismatch',
                    domain: 'example.com',
                    expectedNode: 'Node A',
                    observedChain: ['Node B', 'Global'],
                },
            ],
        });

        test.setConnections([
            { host: 'example.com', chains: ['Node A', 'Global'], startedAt: 200 },
        ]);
        await test.monitor.checkNow();

        expect(test.monitor.read()).toMatchObject({ state: 'healthy', issues: [] });
    });

    it('accepts the current IP without clearing unrelated environment warnings', async () => {
        const test = createTest({
            ips: ['203.0.113.10', '203.0.113.11'],
            settings: settings({
                'environmentMonitor.expectedTimeZone': 'America/Los_Angeles',
            }),
            timeZone: 'Asia/Shanghai',
        });
        await test.monitor.initialize();
        await test.monitor.checkNow();

        expect(test.monitor.useCurrentIp()).toMatchObject({
            state: 'warning',
            issues: [
                {
                    kind: 'timeZoneMismatch',
                    expectedTimeZone: 'America/Los_Angeles',
                    actualTimeZone: 'Asia/Shanghai',
                },
            ],
            canUseCurrentIp: false,
        });
    });
});
