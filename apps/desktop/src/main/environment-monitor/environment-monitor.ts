import type {
    AppSettings,
    EnvironmentMonitorIpProfile,
    EnvironmentMonitorIssue,
    EnvironmentMonitorMihomoSettings,
    EnvironmentMonitorState,
    MihomoControllerAccess,
    ServerEvent,
} from '@caxri/protocol';

import { translateMain } from '../locale';
import type { AgentNotificationDelivery } from '../notifications/agent-notification-delivery';
import type { MihomoConnectionObservation } from './mihomo-controller';
import { readPublicIp, readPublicIpProfile } from './public-ip';

const MONITOR_INTERVAL_MS = 5_000;
const PUBLIC_IP_INTERVAL_MS = 60_000;
/**
 * The 5-second tick reuses the settings it last read instead of asking the Server each time: `settings.changed` (which
 * also covers external edits to the settings file) and `checkNow` mark them stale. Re-reading once a minute anyway
 * covers a change event lost while the Server connection was down. Production logged one `settings.get` every 5
 * seconds, about 28% of all Server request records.
 */
const SETTINGS_REFRESH_MS = 60_000;

type MonitorSettings = Pick<
    AppSettings,
    | 'environmentMonitor.publicIpChanges'
    | 'environmentMonitor.expectedTimeZone'
    | 'environmentMonitor.mihomoRoutes'
>;

interface EnvironmentMonitorOptions {
    delivery: AgentNotificationDelivery;
    fetchPublicIp?: () => Promise<string>;
    fetchPublicIpProfile?: (ip: string, checkedAt: number) => Promise<EnvironmentMonitorIpProfile>;
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

type IpObservation = NonNullable<EnvironmentMonitorState['publicIp']>['current'];
type MihomoStatus = EnvironmentMonitorState['mihomo']['status'];

export interface EnvironmentMonitor {
    checkNow(): Promise<EnvironmentMonitorState>;
    dispose(): void;
    initialize(): Promise<void>;
    observe(event: ServerEvent): void;
    read(): EnvironmentMonitorState;
    readNodes(access: MihomoControllerAccess): Promise<string[]>;
    useCurrentIp(): EnvironmentMonitorState;
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
    actualTimeZone: string,
    publicIpBaseline: IpObservation | undefined,
    currentPublicIp: IpObservation | undefined,
    mihomoStatus: MihomoStatus,
    routeObservations: ReadonlyMap<string, RouteObservation>,
): EnvironmentMonitorState {
    const routeSettings = settings?.['environmentMonitor.mihomoRoutes'];
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
        ...(publicIpBaseline &&
            currentPublicIp && {
                publicIp: { baseline: publicIpBaseline, current: currentPublicIp },
            }),
        timeZone: {
            actual: actualTimeZone,
            expected: settings?.['environmentMonitor.expectedTimeZone'] ?? null,
        },
        mihomo: {
            status: routeSettings?.assertions.length ? mihomoStatus : 'off',
            routes:
                routeSettings?.assertions.map((assertion) => {
                    const observation = routeObservations.get(assertion.domain);
                    return {
                        domain: assertion.domain,
                        expectedNode: assertion.expectedNode,
                        observedChain: observation?.chains ?? [],
                        status: !observation
                            ? ('unobserved' as const)
                            : observation.chains.includes(assertion.expectedNode)
                              ? ('matched' as const)
                              : ('mismatch' as const),
                    };
                }) ?? [],
        },
    };
}

function unavailableProfile(checkedAt: number): EnvironmentMonitorIpProfile {
    return { status: 'unavailable', source: 'checkip.me', checkedAt };
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
    const fetchIpProfile = options.fetchPublicIpProfile ?? readPublicIpProfile;
    const setTimer = options.setInterval ?? globalThis.setInterval;
    const clearTimer = options.clearInterval ?? globalThis.clearInterval;

    let settings: MonitorSettings | undefined;
    let settingsReadAt = 0;
    let areSettingsStale = true;
    let actualTimeZone = getSystemTimeZone();
    let publicIpBaseline: IpObservation | undefined;
    let currentPublicIp: IpObservation | undefined;
    let nextPublicIpCheckAt = 0;
    let lastRouteSettingsFingerprint: string | undefined;
    let routeObservations = new Map<string, RouteObservation>();
    let mihomoStatus: MihomoStatus = 'off';
    let state = stateFor(
        undefined,
        [],
        undefined,
        false,
        actualTimeZone,
        publicIpBaseline,
        currentPublicIp,
        mihomoStatus,
        routeObservations,
    );
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
                    ? `${issue.kind}:${currentPublicIp?.address ?? ''}`
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

    async function readSettings(): Promise<MonitorSettings> {
        if (settings && !areSettingsStale && now() - settingsReadAt < SETTINGS_REFRESH_MS)
            return settings;
        // Cleared before the read, so a `settings.changed` that lands while it is in flight still forces the next one.
        areSettingsStale = false;
        try {
            const next = await options.loadSettings();
            settingsReadAt = now();
            return next;
        } catch (error) {
            areSettingsStale = true;
            throw error;
        }
    }

    async function performCheck(shouldForcePublicIp: boolean): Promise<void> {
        const previousSettings = settings;
        settings = await readSettings();
        const currentTime = now();
        let didCompleteSignal = false;

        const publicIpEnabled = settings['environmentMonitor.publicIpChanges'];
        const publicIpWasEnabled =
            previousSettings?.['environmentMonitor.publicIpChanges'] ?? publicIpEnabled;
        if (!publicIpEnabled) {
            nextPublicIpCheckAt = 0;
        }
        if (shouldForcePublicIp || (publicIpEnabled && currentTime >= nextPublicIpCheckAt)) {
            if (publicIpEnabled) nextPublicIpCheckAt = currentTime + PUBLIC_IP_INTERVAL_MS;
            try {
                const address = await fetchIp();
                const previousObservation =
                    currentPublicIp?.address === address ? currentPublicIp : undefined;
                let profile = previousObservation?.profile ?? unavailableProfile(currentTime);
                if (!previousObservation || shouldForcePublicIp) {
                    try {
                        profile = await fetchIpProfile(address, currentTime);
                    } catch {
                        // Keep context already proven for this address; otherwise expose an explicit unavailable state.
                    }
                }
                currentPublicIp = {
                    address,
                    family: address.includes(':') ? 6 : 4,
                    observedAt: previousObservation?.observedAt ?? currentTime,
                    profile,
                };
                publicIpBaseline ??= currentPublicIp;
                if (!publicIpWasEnabled && publicIpEnabled) publicIpBaseline = currentPublicIp;
                didCompleteSignal = true;
            } catch {
                // A failed lookup is not an environment anomaly and must not replace the last known result.
            }
        }

        const expectedTimeZone = settings['environmentMonitor.expectedTimeZone'];
        actualTimeZone = getSystemTimeZone();
        if (expectedTimeZone !== null) didCompleteSignal = true;

        const routeSettings = settings['environmentMonitor.mihomoRoutes'];
        const routeFingerprint = routeSettingsFingerprint(routeSettings);
        if (routeFingerprint !== lastRouteSettingsFingerprint) {
            routeObservations = new Map();
            lastRouteSettingsFingerprint = routeFingerprint;
        }
        mihomoStatus = routeSettings.assertions.length === 0 ? 'off' : 'unavailable';
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
                mihomoStatus = 'available';
                didCompleteSignal = true;
            } catch {
                // A controller failure is report context, not a new warning; retain the last proven route evidence.
            }
        }

        const issues: EnvironmentMonitorIssue[] = [];
        if (
            publicIpEnabled &&
            publicIpBaseline?.address &&
            currentPublicIp?.address &&
            publicIpBaseline.address !== currentPublicIp.address
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
            actualTimeZone,
            publicIpBaseline,
            currentPublicIp,
            mihomoStatus,
            routeObservations,
        );
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
        checkNow: () => {
            areSettingsStale = true;
            return enqueue(true);
        },
        dispose: () => clearTimer(timer),
        initialize: async () => {
            await enqueue(false);
        },
        observe: (event) => {
            if (event.event !== 'settings.changed') return;
            areSettingsStale = true;
            void enqueue(false);
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
            state = stateFor(
                settings,
                issues,
                state.checkedAt,
                false,
                actualTimeZone,
                publicIpBaseline,
                currentPublicIp,
                mihomoStatus,
                routeObservations,
            );
            return state;
        },
    };
}
