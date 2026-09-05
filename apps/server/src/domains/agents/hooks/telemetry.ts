import type { AgentProvider } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import { countFields } from '../../log-count-fields';
import type { AgentLifecyclePhase, AgentSignalIgnoredReason } from './contract';
import type { AgentHookSignalDiagnostic } from './server';

type SettledSignalDiagnostic = Exclude<AgentHookSignalDiagnostic, { outcome: 'started' }>;

/**
 * Per-launch counters behind `agent_hooks.launch_summary`. The per-signal records are deduplicated so a chatty Agent
 * cannot flood the log, which means they answer "did this shape of signal ever arrive" but never "how many". These
 * counters restore the volume, the phase distribution, and the ignore-reason distribution at one record per launch.
 */
interface HookLaunchTally {
    accepted: number;
    firstSignalMs?: number;
    ignored: number;
    readonly ignoredReasons: Map<AgentSignalIgnoredReason, number>;
    maxHandlingMs: number;
    readonly phases: Map<AgentLifecyclePhase, number>;
    readonly preparedAt: number;
    provider?: AgentProvider;
    rejected: number;
}

function newLaunchTally(provider: AgentProvider | undefined): HookLaunchTally {
    return {
        accepted: 0,
        ignored: 0,
        ignoredReasons: new Map(),
        maxHandlingMs: 0,
        phases: new Map(),
        preparedAt: Date.now(),
        provider,
        rejected: 0,
    };
}

/**
 * Owns everything the hook boundary records about itself: which per-signal diagnostics reach the log, the per-launch
 * aggregate that survives that deduplication, and the coarse metric pair published to the process manifest.
 *
 * The split exists because the two audiences need opposite things. Diagnosing one failure needs a detailed record of
 * the first signal of each shape; noticing an unreported problem needs the totals, the ignore-reason distribution, and
 * the worst handling time across a whole launch. Emitting a full record per signal would satisfy both and drown the
 * log, so this class keeps the detail sampled and the counts exact.
 */
export class AgentHookTelemetry {
    private readonly loggedDiagnostics = new Map<string, Set<string>>();
    private readonly tallies = new Map<string, HookLaunchTally>();

    constructor(private readonly logger: StructuredLogger) {}

    private writeBridgeStarted(
        diagnostic: Extract<AgentHookSignalDiagnostic, { outcome: 'started' }>,
    ): void {
        const key = `started:${diagnostic.provider}:${diagnostic.phase}`;
        if (!this.claimFirst(diagnostic.terminalId, key)) return;
        this.logger.write('info', logEventCatalog.agentHooks.bridgeStarted, {
            fields: {
                stage: 'serverCore',
                phase: diagnostic.phase,
                provider: diagnostic.provider,
                terminalId: diagnostic.terminalId,
            },
        });
    }

    private writeSignal(diagnostic: SettledSignalDiagnostic): void {
        // Read before the rest spread: the accepted variant has no `reason`, so the narrowing must happen on the
        // discriminated diagnostic rather than on the widened remainder.
        const reason = diagnostic.outcome === 'accepted' ? undefined : diagnostic.reason;
        const { handlingMs, outcome, ...fields } = diagnostic;
        /**
         * A rejection is rare and security-relevant, so every one is logged. An accepted or ignored signal repeats for
         * the whole life of an Agent Terminal, so only the first of each shape is.
         */
        if (
            outcome !== 'rejected' &&
            fields.terminalId &&
            fields.phase &&
            !this.claimFirst(
                fields.terminalId,
                `${outcome}:${reason ?? ''}:${fields.provider}:${fields.phase}:${fields.hasAgentSessionId}`,
            )
        )
            return;
        this.logger.write(
            outcome === 'rejected' ? 'warn' : 'info',
            outcome === 'accepted'
                ? logEventCatalog.agentHooks.signalAccepted
                : outcome === 'ignored'
                  ? logEventCatalog.agentHooks.signalIgnored
                  : logEventCatalog.agentHooks.signalRejected,
            {
                ...(handlingMs !== undefined && { durationMs: handlingMs }),
                fields: { stage: 'serverCore', ...fields },
            },
        );
    }

    /**
     * Counts one settled signal against its launch and publishes the coarse metric pair. Metrics are recorded even for
     * a signal that matches no live launch (a stale or forged token), because that volume is exactly what a manifest
     * reader needs to notice hooks firing into nothing.
     */
    private count(diagnostic: SettledSignalDiagnostic): void {
        this.logger.recordMetric('hook.signal', 1, {
            outcome:
                diagnostic.outcome === 'accepted'
                    ? 'success'
                    : diagnostic.outcome === 'ignored'
                      ? 'cancelled'
                      : 'failure',
            owner: 'server-core',
            phase: 'admission',
        });
        if (diagnostic.handlingMs !== undefined)
            this.logger.recordMetric('hook.latency', diagnostic.handlingMs, {
                owner: 'server-core',
                phase: 'admission',
            });
        const tally = diagnostic.terminalId ? this.tallies.get(diagnostic.terminalId) : undefined;
        if (!tally) return;
        tally.firstSignalMs ??= Date.now() - tally.preparedAt;
        if (diagnostic.handlingMs !== undefined)
            tally.maxHandlingMs = Math.max(tally.maxHandlingMs, diagnostic.handlingMs);
        if (diagnostic.phase)
            tally.phases.set(diagnostic.phase, (tally.phases.get(diagnostic.phase) ?? 0) + 1);
        if (diagnostic.outcome === 'accepted') tally.accepted += 1;
        else if (diagnostic.outcome === 'ignored') {
            tally.ignored += 1;
            tally.ignoredReasons.set(
                diagnostic.reason,
                (tally.ignoredReasons.get(diagnostic.reason) ?? 0) + 1,
            );
        } else tally.rejected += 1;
    }

    /**
     * Returns `true` the first time a diagnostic shape is seen for a Terminal, so the caller writes one record per
     * shape per launch instead of one per signal.
     */
    private claimFirst(terminalId: string, key: string): boolean {
        const logged = this.loggedDiagnostics.get(terminalId) ?? new Set<string>();
        if (logged.has(key)) return false;
        logged.add(key);
        this.loggedDiagnostics.set(terminalId, logged);
        return true;
    }

    beginLaunch(terminalId: string, provider?: AgentProvider): void {
        this.loggedDiagnostics.delete(terminalId);
        this.tallies.set(terminalId, newLaunchTally(provider));
    }

    /**
     * Publishes the launch aggregate and drops its state. A launch that ends with `signals: 0` is the loudest record
     * this class emits: the hook environment reached the PTY and nothing ever came back.
     */
    endLaunch(terminalId: string): void {
        const tally = this.tallies.get(terminalId);
        this.loggedDiagnostics.delete(terminalId);
        this.tallies.delete(terminalId);
        if (!tally) return;
        this.logger.write('info', logEventCatalog.agentHooks.launchSummary, {
            durationMs: Date.now() - tally.preparedAt,
            fields: {
                stage: 'serverCore',
                terminalId,
                ...(tally.provider && { provider: tally.provider }),
                signals: tally.accepted + tally.ignored + tally.rejected,
                accepted: tally.accepted,
                ignored: tally.ignored,
                rejected: tally.rejected,
                ...(tally.firstSignalMs !== undefined && { firstSignalMs: tally.firstSignalMs }),
                ...(tally.maxHandlingMs > 0 && { maxHandlingMs: tally.maxHandlingMs }),
                ...countFields('phase', tally.phases),
                ...countFields('ignored', tally.ignoredReasons),
            },
        });
    }

    record(diagnostic: AgentHookSignalDiagnostic): void {
        if (diagnostic.outcome === 'started') {
            this.writeBridgeStarted(diagnostic);
            return;
        }
        // Counting happens before the dedup gate: the per-signal records answer "did this shape ever arrive", and only
        // the tally can answer "how many".
        this.count(diagnostic);
        this.writeSignal(diagnostic);
    }
}
