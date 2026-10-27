import { createHash } from 'node:crypto';

import type {
    EnvironmentMonitorDetails,
    EnvironmentMonitorIssueKind,
    EnvironmentMonitorProxyMode,
    EnvironmentMonitorState,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { notifyListeners } from '@caxri/utils';

import type { EnvironmentMonitorProbeFailureReason } from './probe';
import { environmentMonitorProbeFailureReason, normalizeProxyRoute } from './probe';
import type { EnvironmentMonitorProbe, EnvironmentMonitorSignals } from './types';
import { hasEnvironmentMonitorSignal, requiresExternalEnvironmentProbe } from './types';

const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const EXTERNAL_PROBE_SKIPPED =
    'externalProbeSkipped' satisfies EnvironmentMonitorProbeFailureReason;

export const defaultEnvironmentMonitorSignals: EnvironmentMonitorSignals = {
    publicIpChanges: true,
    proxyProtection: false,
    locationChanges: false,
    timeZoneMismatch: false,
    checkUnavailable: false,
};

interface EnvironmentSnapshot {
    checkedAt: number;
    details: EnvironmentMonitorDetails;
    ipFingerprint?: string;
    locationFingerprint?: string;
    proxyFingerprint?: string;
    proxyUnavailable: boolean;
}

interface EnvironmentBaseline {
    ipFingerprint?: string;
    locationFingerprint?: string;
    proxyFingerprint?: string;
}

export interface EnvironmentMonitor {
    acceptBaseline(): EnvironmentMonitorState;
    dispose(): void;
    read(): EnvironmentMonitorState;
    refresh(): Promise<EnvironmentMonitorState>;
    settingsChanged(): void;
    start(): void;
    subscribeAlerts(listener: (event: EnvironmentMonitorAlertEvent) => void): () => void;
}

export type EnvironmentMonitorAlertEvent =
    { type: 'clear' } | { state: EnvironmentMonitorState; type: 'show' };

interface EnvironmentMonitorOptions {
    failureThreshold?: number;
    loadSignals?: () => Promise<EnvironmentMonitorSignals>;
    logger?: () => StructuredLogger | undefined;
    monotonicNow?: () => number;
    now?: () => number;
    pollIntervalMs?: number;
    probe: EnvironmentMonitorProbe;
    systemTimeZone?: () => string;
}

function fingerprint(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

export function proxyModeOf(route: string): EnvironmentMonitorProxyMode {
    const parts = normalizeProxyRoute(route).split(';').filter(Boolean);
    const hasDirect = parts.includes('DIRECT');
    const hasProxy = parts.some((part) => /^(?:PROXY|HTTPS?|SOCKS\d?|QUIC)\s/iu.test(part));
    if (hasDirect && hasProxy) return 'mixed';
    if (hasProxy) return 'proxy';
    if (hasDirect) return 'direct';
    return 'unknown';
}

export function timeZoneOffsetMinutes(zone: string, timestamp: number): number | undefined {
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: zone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(new Date(timestamp));
        const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
        const representedAsUtc = Date.UTC(
            Number(values.year),
            Number(values.month) - 1,
            Number(values.day),
            Number(values.hour),
            Number(values.minute),
            Number(values.second),
        );
        return Math.round((representedAsUtc - timestamp) / 60_000);
    } catch {
        return undefined;
    }
}

function systemTimeZone(): string {
    try {
        // react-doctor-disable-next-line react-doctor/js-hoist-intl -- A fresh formatter re-reads a system time-zone change while Desktop remains open.
        return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
}

function issueSignature(issues: readonly EnvironmentMonitorIssueKind[]): string {
    return issues.join(',');
}

function syncBaseline(
    baseline: EnvironmentBaseline,
    snapshot: EnvironmentSnapshot,
    signals: EnvironmentMonitorSignals,
): EnvironmentBaseline {
    return {
        ipFingerprint:
            signals.publicIpChanges && baseline.ipFingerprint === undefined
                ? snapshot.ipFingerprint
                : baseline.ipFingerprint,
        locationFingerprint:
            signals.locationChanges && baseline.locationFingerprint === undefined
                ? snapshot.locationFingerprint
                : baseline.locationFingerprint,
        proxyFingerprint:
            signals.proxyProtection && baseline.proxyFingerprint === undefined
                ? snapshot.proxyFingerprint
                : baseline.proxyFingerprint,
    };
}

function activeDetails(
    snapshot: EnvironmentSnapshot | undefined,
    signals: EnvironmentMonitorSignals,
): EnvironmentMonitorDetails | undefined {
    if (!snapshot) return undefined;
    const details: EnvironmentMonitorDetails = {
        ...(signals.locationChanges &&
            snapshot.details.countryCode && { countryCode: snapshot.details.countryCode }),
        ...(signals.locationChanges &&
            snapshot.details.region && { region: snapshot.details.region }),
        ...(signals.locationChanges &&
            snapshot.details.network && { network: snapshot.details.network }),
        ...(signals.timeZoneMismatch &&
            snapshot.details.egressTimeZone && { egressTimeZone: snapshot.details.egressTimeZone }),
        ...(signals.timeZoneMismatch &&
            snapshot.details.systemTimeZone && { systemTimeZone: snapshot.details.systemTimeZone }),
        ...(signals.proxyProtection &&
            snapshot.details.proxyMode && { proxyMode: snapshot.details.proxyMode }),
    };
    return Object.keys(details).length > 0 ? details : undefined;
}

function issuesFor(
    snapshot: EnvironmentSnapshot | undefined,
    baseline: EnvironmentBaseline,
    signals: EnvironmentMonitorSignals,
    consecutiveFailures: number,
    failureThreshold: number,
): EnvironmentMonitorIssueKind[] {
    const issues: EnvironmentMonitorIssueKind[] = [];
    if (
        signals.publicIpChanges &&
        snapshot?.ipFingerprint &&
        baseline.ipFingerprint &&
        snapshot.ipFingerprint !== baseline.ipFingerprint
    )
        issues.push('publicIpChanged');
    if (
        signals.locationChanges &&
        snapshot?.locationFingerprint &&
        baseline.locationFingerprint &&
        snapshot.locationFingerprint !== baseline.locationFingerprint
    )
        issues.push('locationChanged');
    if (
        signals.proxyProtection &&
        snapshot?.proxyFingerprint &&
        baseline.proxyFingerprint &&
        snapshot.proxyFingerprint !== baseline.proxyFingerprint
    )
        issues.push('proxyRouteChanged');
    if (signals.proxyProtection && snapshot?.proxyUnavailable) issues.push('proxyUnavailable');
    if (signals.timeZoneMismatch && snapshot?.details.egressTimeZone) {
        const egressOffset = timeZoneOffsetMinutes(
            snapshot.details.egressTimeZone,
            snapshot.checkedAt,
        );
        const localOffset = snapshot.details.systemTimeZone
            ? timeZoneOffsetMinutes(snapshot.details.systemTimeZone, snapshot.checkedAt)
            : undefined;
        if (egressOffset !== undefined && localOffset !== undefined && egressOffset !== localOffset)
            issues.push('timeZoneMismatch');
    }
    if (signals.checkUnavailable && consecutiveFailures >= failureThreshold)
        issues.push('checkUnavailable');
    return issues;
}

function issueLogFields(issues: readonly EnvironmentMonitorIssueKind[]) {
    return {
        issueCount: issues.length,
        publicIpChanged: issues.includes('publicIpChanged'),
        locationChanged: issues.includes('locationChanged'),
        proxyRouteChanged: issues.includes('proxyRouteChanged'),
        proxyUnavailable: issues.includes('proxyUnavailable'),
        timeZoneMismatch: issues.includes('timeZoneMismatch'),
        checkUnavailable: issues.includes('checkUnavailable'),
    };
}

function signalLogFields(signals: EnvironmentMonitorSignals) {
    return {
        checkUnavailableEnabled: signals.checkUnavailable,
        locationChangesEnabled: signals.locationChanges,
        proxyProtectionEnabled: signals.proxyProtection,
        publicIpChangesEnabled: signals.publicIpChanges,
        timeZoneMismatchEnabled: signals.timeZoneMismatch,
    };
}

function resetNewSignalBaselines(
    baseline: EnvironmentBaseline,
    previous: EnvironmentMonitorSignals,
    next: EnvironmentMonitorSignals,
): EnvironmentBaseline {
    return {
        ipFingerprint:
            !previous.publicIpChanges && next.publicIpChanges ? undefined : baseline.ipFingerprint,
        locationFingerprint:
            !previous.locationChanges && next.locationChanges
                ? undefined
                : baseline.locationFingerprint,
        proxyFingerprint:
            !previous.proxyProtection && next.proxyProtection
                ? undefined
                : baseline.proxyFingerprint,
    };
}

export function createEnvironmentMonitor({
    failureThreshold = DEFAULT_FAILURE_THRESHOLD,
    loadSignals = () => Promise.resolve(defaultEnvironmentMonitorSignals),
    logger,
    monotonicNow = performance.now.bind(performance),
    now = Date.now,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    probe,
    systemTimeZone: readSystemTimeZone = systemTimeZone,
}: EnvironmentMonitorOptions): EnvironmentMonitor {
    let activeSignals = defaultEnvironmentMonitorSignals;
    let baseline: EnvironmentBaseline = {};
    let current: EnvironmentSnapshot | undefined;
    let consecutiveFailures = 0;
    let checkedAt: number | undefined;
    let lastSuccessfulAt: number | undefined;
    let inFlight: Promise<EnvironmentMonitorState> | undefined;
    let isRefreshAfterFlight = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let controller: AbortController | undefined;
    let isDisposed = false;
    let state: EnvironmentMonitorState = {
        state: 'checking',
        issues: [],
        consecutiveFailures: 0,
        canAcceptBaseline: false,
    };
    const alertListeners = new Set<(event: EnvironmentMonitorAlertEvent) => void>();

    const projectState = (): EnvironmentMonitorState => {
        if (!hasEnvironmentMonitorSignal(activeSignals))
            return {
                state: 'disabled',
                issues: [],
                consecutiveFailures: 0,
                canAcceptBaseline: false,
            };
        const issues = issuesFor(
            current,
            baseline,
            activeSignals,
            consecutiveFailures,
            failureThreshold,
        );
        const unavailable = issues.includes('checkUnavailable');
        const details = activeDetails(current, activeSignals);
        return {
            state: unavailable
                ? 'unavailable'
                : issues.length > 0
                  ? 'warning'
                  : current
                    ? 'healthy'
                    : 'checking',
            issues,
            ...(checkedAt !== undefined && { checkedAt }),
            ...(lastSuccessfulAt !== undefined && { lastSuccessfulAt }),
            consecutiveFailures,
            canAcceptBaseline: issues.some((issue) =>
                ['publicIpChanged', 'locationChanged', 'proxyRouteChanged'].includes(issue),
            ),
            ...(details && { details }),
        };
    };

    const publish = (
        next: EnvironmentMonitorState,
        durationMs: number | null,
        shouldNotify = true,
    ): void => {
        const previousState = state.state;
        const previousIssueKinds = state.issues;
        const previousIssues = issueSignature(previousIssueKinds);
        state = next;
        const signature = issueSignature(next.issues);
        if (previousIssues !== signature || previousState !== next.state)
            logger?.()?.write('info', logEventCatalog.environmentMonitor.stateChanged, {
                fields: {
                    fromState: previousState,
                    toState: next.state,
                    consecutiveFailures: next.consecutiveFailures,
                    durationMs,
                    ...signalLogFields(activeSignals),
                    ...issueLogFields(next.issues),
                },
            });
        if (previousIssues === signature) return;
        const previousIssueSet = new Set(previousIssueKinds);
        const addedIssue = next.issues.some((issue) => !previousIssueSet.has(issue));
        if (shouldNotify && addedIssue) {
            notifyListeners(alertListeners, { type: 'show', state: next });
            return;
        }
        notifyListeners(alertListeners, { type: 'clear' });
    };

    const runProbe = async (): Promise<EnvironmentMonitorState> => {
        const startedAt = monotonicNow();
        checkedAt = now();
        controller = new AbortController();
        try {
            const nextSignals = await loadSignals();
            baseline = resetNewSignalBaselines(baseline, activeSignals, nextSignals);
            activeSignals = nextSignals;
            if (!hasEnvironmentMonitorSignal(activeSignals)) {
                consecutiveFailures = 0;
                publish(projectState(), Math.max(0, monotonicNow() - startedAt));
                return state;
            }
            const reading = await probe(activeSignals, controller.signal);
            if (isDisposed) return state;
            const next: EnvironmentSnapshot = {
                checkedAt,
                details: { ...current?.details },
                ipFingerprint: current?.ipFingerprint,
                locationFingerprint: current?.locationFingerprint,
                proxyFingerprint: current?.proxyFingerprint,
                proxyUnavailable: false,
            };
            if (reading.egress) {
                if (activeSignals.publicIpChanges)
                    next.ipFingerprint = fingerprint(reading.egress.ip);
                if (activeSignals.locationChanges)
                    next.locationFingerprint =
                        reading.egress.countryCode || reading.egress.region
                            ? fingerprint(
                                  `${reading.egress.countryCode ?? ''}\n${reading.egress.region ?? ''}`,
                              )
                            : undefined;
                next.details = {
                    ...next.details,
                    countryCode: activeSignals.locationChanges
                        ? reading.egress.countryCode
                        : undefined,
                    region: activeSignals.locationChanges ? reading.egress.region : undefined,
                    network: activeSignals.locationChanges ? reading.egress.network : undefined,
                    egressTimeZone: activeSignals.timeZoneMismatch
                        ? reading.egress.timeZone
                        : undefined,
                    systemTimeZone: activeSignals.timeZoneMismatch
                        ? readSystemTimeZone()
                        : undefined,
                };
            }
            if (activeSignals.proxyProtection && reading.proxy) {
                const route = normalizeProxyRoute(reading.proxy.route);
                next.proxyFingerprint = fingerprint(route || 'unknown');
                next.proxyUnavailable = reading.proxy.available === false;
                next.details = { ...next.details, proxyMode: proxyModeOf(route) };
            }
            current = next;
            baseline = syncBaseline(baseline, next, activeSignals);
            const externalProbeMissed =
                reading.egress === undefined && requiresExternalEnvironmentProbe(activeSignals);
            const durationMs = Math.max(0, monotonicNow() - startedAt);
            if (externalProbeMissed) {
                consecutiveFailures += 1;
                logger?.()?.write('warn', logEventCatalog.environmentMonitor.probeFailed, {
                    fields: {
                        consecutiveFailures,
                        durationMs,
                        failureReason: EXTERNAL_PROBE_SKIPPED,
                        ...signalLogFields(activeSignals),
                    },
                });
            } else {
                consecutiveFailures = 0;
                lastSuccessfulAt = checkedAt;
            }
            publish(projectState(), durationMs);
        } catch (error) {
            if (isDisposed || controller.signal.aborted) return state;
            consecutiveFailures += 1;
            const durationMs = Math.max(0, monotonicNow() - startedAt);
            logger?.()?.write('warn', logEventCatalog.environmentMonitor.probeFailed, {
                fields: {
                    consecutiveFailures,
                    durationMs,
                    failureReason: environmentMonitorProbeFailureReason(error),
                    ...signalLogFields(activeSignals),
                },
            });
            publish(projectState(), durationMs);
        } finally {
            controller = undefined;
        }
        return state;
    };

    const refresh = async (): Promise<EnvironmentMonitorState> => {
        if (isDisposed) return state;
        if (inFlight) return inFlight;
        const task = runProbe();
        inFlight = task;
        try {
            return await task;
        } finally {
            inFlight = undefined;
            if (isRefreshAfterFlight) {
                isRefreshAfterFlight = false;

                void refresh();
            }
        }
    };

    return {
        acceptBaseline() {
            if (!current) return state;
            baseline = {
                ipFingerprint: current.ipFingerprint,
                locationFingerprint: current.locationFingerprint,
                proxyFingerprint: current.proxyFingerprint,
            };
            const next = projectState();
            publish(next, null, false);
            return state;
        },
        dispose() {
            isDisposed = true;
            if (timer) clearInterval(timer);
            timer = undefined;
            controller?.abort();
            alertListeners.clear();
        },
        read: () => state,
        refresh,
        settingsChanged() {
            if (inFlight) {
                isRefreshAfterFlight = true;
                return;
            }

            void refresh();
        },
        start() {
            if (isDisposed || timer) return;

            void refresh();
            timer = setInterval(() => {
                void refresh();
            }, pollIntervalMs);
        },
        subscribeAlerts(listener) {
            alertListeners.add(listener);
            return () => alertListeners.delete(listener);
        },
    };
}
