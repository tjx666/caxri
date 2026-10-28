import { isIP } from 'node:net';

import type {
    AppSettings,
    EnvironmentMonitorIssue,
    EnvironmentMonitorMihomoSettings,
    EnvironmentMonitorState,
    MihomoControllerAccess,
    ServerEvent,
} from '@caxri/protocol';

import { translateMain } from '../locale';
import type { AgentNotificationDelivery } from '../notifications/agent-notification-delivery';
import type { MihomoConnectionObservation } from './mihomo-controller';

const MONITOR_INTERVAL_MS = 5_000;
const PUBLIC_IP_INTERVAL_MS = 60_000;
const PUBLIC_IP_ENDPOINT = 'https://api.ipify.org?format=json';

type PublicIpFetcher = (input: string, init?: RequestInit) => Promise<Response>;

type MonitorSettings = Pick<
    AppSettings,
    | 'environmentMonitor.publicIpChanges'
    | 'environmentMonitor.expectedTimeZone'
    | 'environmentMonitor.mihomoRoutes'
>;

interface EnvironmentMonitorOptions {
    delivery: AgentNotificationDelivery;
    fetchPublicIp?: () => Promise<string>;
    focusMainWindow(): Promise<unknown>;
    getSystemTimeZone?: () => string;
    loadSettings(): Promise<MonitorSettings>;
    now?: () => number;
    readConnections?: (
        settings: EnvironmentMonitorMihomoSettings,
        now: number,
    ) => Promise<MihomoConnectionObservation[]>;
    readNodes(settings: EnvironmentMonitorMihomoSettings): Promise<string[]>;
    setInterval?: typeof globalThis.setInterval;
    clearInterval?: typeof globalThis.clearInterval;
}

interface RouteObservation {
    chains: string[];
    startedAt: number;
}

export interface EnvironmentMonitor {
    checkNow(): Promise<EnvironmentMonitorState>;
    dispose(): void;
    initialize(): Promise<void>;
    observe(event: ServerEvent): void;
    read(): EnvironmentMonitorState;
    readNodes(access: MihomoControllerAccess): Promise<string[]>;
    useCurrentIp(): EnvironmentMonitorState;
}

export async function readPublicIp(fetcher: PublicIpFetcher = fetch): Promise<string> {
    const response = await fetcher(PUBLIC_IP_ENDPOINT, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error('public IP request failed');
    const payload = (await response.json()) as { ip?: unknown };
    if (typeof payload.ip !== 'string' || isIP(payload.ip) === 0)
        throw new Error('public IP response is invalid');
    return payload.ip;
}

function hasActiveSignals(settings: MonitorSettings): boolean {
    return (
        settings['environmentMonitor.publicIpChanges'] ||
        settings['environmentMonitor.expectedTimeZone'] !== null ||
        settings['environmentMonitor.mihomoRoutes'].assertions.length > 0
    );
}

function routeSettingsFingerprint(settings: EnvironmentMonitorMihomoSettings): string {
    return JSON.stringify(settings);
}

function stateFor(
    settings: MonitorSettings | undefined,
    issues: EnvironmentMonitorIssue[],
    checkedAt: number | undefined,
    canUseCurrentIp: boolean,
): EnvironmentMonitorState {
    return {
        state:
            !settings || !hasActiveSignals(settings)
                ? 'disabled'
                : issues.length > 0
                  ? 'warning'
                  : 'healthy',
        issues,
        checkedAt,
        canUseCurrentIp,
    };
}

function notificationCopy(issue: EnvironmentMonitorIssue): { body: string; id: string } {
    switch (issue.kind) {
        case 'publicIpChanged':
            return {
                body: translateMain('desktop.notification.environmentMonitor.publicIpChanged'),
                id: 'environment-monitor-public-ip',
            };
        case 'timeZoneMismatch':
            return {
                body: translateMain('desktop.notification.environmentMonitor.timeZoneMismatch'),
                id: 'environment-monitor-time-zone',
            };
        case 'routeNodeMismatch':
            return {
                body: translateMain('desktop.notification.environmentMonitor.routeNodeMismatch'),
                id: `environment-monitor-route-${issue.domain}`,
            };
    }
}

/**
 * Monitors only explicit expectations. Public IP is boot-scoped; route assertions consume Mihomo's already-existing
 * connection list and never create a request to a configured domain.
 */
export function createEnvironmentMonitor(options: EnvironmentMonitorOptions): EnvironmentMonitor {
    const now = options.now ?? Date.now;
    const getSystemTimeZone =
        options.getSystemTimeZone ??
        (() => {
            // react-doctor-disable-next-line react-doctor/js-hoist-intl -- A shared formatter freezes the default time zone and would miss a system change while Caxri is open.
            return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown';
        });
    const fetchIp = options.fetchPublicIp ?? readPublicIp;
    const setTimer = options.setInterval ?? globalThis.setInterval;
    const clearTimer = options.clearInterval ?? globalThis.clearInterval;

    let settings: MonitorSettings | undefined;
    let state = stateFor(undefined, [], undefined, false);
    let publicIpBaseline: string | undefined;
    let currentPublicIp: string | undefined;
    let nextPublicIpCheckAt = 0;
    let lastRouteSettingsFingerprint: string | undefined;
    let routeObservations = new Map<string, RouteObservation>();
    let alertFingerprints = new Set<string>();
    let activeCheck: Promise<void> | undefined;
    const timer = setTimer(() => {
        void enqueue(false);
    }, MONITOR_INTERVAL_MS);

    function notifyNewIssues(issues: EnvironmentMonitorIssue[]): void {
        const nextFingerprints = new Set<string>();
        for (const issue of issues) {
            const fingerprint =
                issue.kind === 'publicIpChanged'
                    ? `${issue.kind}:${currentPublicIp ?? ''}`
                    : issue.kind === 'timeZoneMismatch'
                      ? `${issue.kind}:${issue.expectedTimeZone}:${issue.actualTimeZone}`
                      : `${issue.kind}:${issue.domain}:${issue.expectedNode}:${issue.observedChain.join('\0')}`;
            nextFingerprints.add(fingerprint);
            if (alertFingerprints.has(fingerprint)) continue;
            const copy = notificationCopy(issue);
            options.delivery.show(
                {
                    body: copy.body,
                    groupId: 'environment-monitor',
                    id: copy.id,
                    title: translateMain('desktop.notification.environmentMonitor.title'),
                },
                () => {
                    void options.focusMainWindow();
                },
            );
        }
        alertFingerprints = nextFingerprints;
    }

    async function performCheck(shouldForcePublicIp: boolean): Promise<void> {
        const previousSettings = settings;
        settings = await options.loadSettings();
        const currentTime = now();
        let didCompleteSignal = false;

        if (!settings['environmentMonitor.publicIpChanges']) {
            publicIpBaseline = undefined;
            currentPublicIp = undefined;
            nextPublicIpCheckAt = 0;
        } else if (shouldForcePublicIp || currentTime >= nextPublicIpCheckAt) {
            nextPublicIpCheckAt = currentTime + PUBLIC_IP_INTERVAL_MS;
            try {
                currentPublicIp = await fetchIp();
                publicIpBaseline ??= currentPublicIp;
                didCompleteSignal = true;
            } catch {
                // A failed lookup is not an environment anomaly and must not replace the last known result.
            }
        }

        const expectedTimeZone = settings['environmentMonitor.expectedTimeZone'];
        const actualTimeZone = getSystemTimeZone();
        if (expectedTimeZone !== null) didCompleteSignal = true;

        const routeSettings = settings['environmentMonitor.mihomoRoutes'];
        const routeFingerprint = routeSettingsFingerprint(routeSettings);
        if (routeFingerprint !== lastRouteSettingsFingerprint) {
            routeObservations = new Map();
            lastRouteSettingsFingerprint = routeFingerprint;
        }
        if (routeSettings.assertions.length > 0 && options.readConnections) {
            try {
                const connections = await options.readConnections(routeSettings, currentTime);
                for (const assertion of routeSettings.assertions) {
                    const newest = connections
                        .filter((connection) => connection.host === assertion.domain)
                        .toSorted((left, right) => right.startedAt - left.startedAt)
                        .at(0);
                    const previous = routeObservations.get(assertion.domain);
                    if (newest && (!previous || newest.startedAt >= previous.startedAt))
                        routeObservations.set(assertion.domain, {
                            chains: newest.chains,
                            startedAt: newest.startedAt,
                        });
                }
                didCompleteSignal = true;
            } catch {
                // Controller availability belongs in the Settings editor, not the environment warning surface.
            }
        }

        const issues: EnvironmentMonitorIssue[] = [];
        if (
            publicIpBaseline !== currentPublicIp &&
            publicIpBaseline &&
            currentPublicIp &&
            settings['environmentMonitor.publicIpChanges']
        )
            issues.push({ kind: 'publicIpChanged' });
        if (expectedTimeZone !== null && expectedTimeZone !== actualTimeZone)
            issues.push({ kind: 'timeZoneMismatch', expectedTimeZone, actualTimeZone });
        for (const assertion of routeSettings.assertions) {
            const observation = routeObservations.get(assertion.domain);
            if (observation && !observation.chains.includes(assertion.expectedNode))
                issues.push({
                    kind: 'routeNodeMismatch',
                    domain: assertion.domain,
                    expectedNode: assertion.expectedNode,
                    observedChain: observation.chains,
                });
        }

        notifyNewIssues(issues);
        state = stateFor(
            settings,
            issues,
            didCompleteSignal ? currentTime : state.checkedAt,
            issues.some((issue) => issue.kind === 'publicIpChanged'),
        );

        if (
            previousSettings &&
            previousSettings['environmentMonitor.publicIpChanges'] !==
                settings['environmentMonitor.publicIpChanges']
        )
            nextPublicIpCheckAt = 0;
    }

    async function enqueue(shouldForcePublicIp: boolean): Promise<EnvironmentMonitorState> {
        const previousCheck = activeCheck;
        const currentCheck = (async () => {
            if (previousCheck) {
                try {
                    await previousCheck;
                } catch {
                    // The queued check still runs after an earlier settings read failed.
                }
            }
            await performCheck(shouldForcePublicIp);
        })();
        activeCheck = currentCheck;
        try {
            await currentCheck;
        } catch {
            // A settings read can fail only while the local Runtime is unavailable; preserve the last state.
        } finally {
            if (activeCheck === currentCheck) activeCheck = undefined;
        }
        return state;
    }

    return {
        checkNow: () => enqueue(true),
        dispose: () => clearTimer(timer),
        initialize: async () => {
            await enqueue(true);
        },
        observe: (event) => {
            if (event.event === 'settings.changed') void enqueue(false);
        },
        read: () => state,
        readNodes: (access) => options.readNodes({ ...access, assertions: [] }),
        useCurrentIp: () => {
            if (currentPublicIp) publicIpBaseline = currentPublicIp;
            const issues = state.issues.filter((issue) => issue.kind !== 'publicIpChanged');
            alertFingerprints = new Set(
                [...alertFingerprints].filter(
                    (fingerprint) => !fingerprint.startsWith('publicIpChanged:'),
                ),
            );
            state = stateFor(settings, issues, state.checkedAt, false);
            return state;
        },
    };
}
