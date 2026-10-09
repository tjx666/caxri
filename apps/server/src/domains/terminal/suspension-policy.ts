import type { AppSettings, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import { isPtyTerminal } from '../pty-guard';

export type TerminalSuspensionReason = 'idle' | 'untouched';

export interface TerminalSuspensionDecision {
    reason: TerminalSuspensionReason;
    terminalId: string;
}

/**
 * In-memory activity observed for one Agent launch. Timestamps are absent when the launch predates this Server process,
 * which keeps the "untouched" rule from judging input it never saw.
 */
export interface TerminalActivitySample {
    launchedAt?: number;
    lastInputAt?: number;
    lastTurnFinishedAt?: number;
    lastTurnStartedAt?: number;
    turnInFlight: boolean;
}

export interface TerminalSuspensionPolicyInput {
    now: number;
    /**
     * When this Server process started; a launch older than the process counts as active since then for the idle rule.
     */
    startedAt: number;
    selectedSessionId: string | undefined;
    settings: Pick<AppSettings, 'terminal.suspendIdleAgents' | 'terminal.suspendUntouchedAgents'>;
    terminals: readonly TerminalRecord[];
    deselectedAt(sessionId: string): number | undefined;
    sample(terminalId: string): TerminalActivitySample | undefined;
    session(sessionId: string): SessionRecord | undefined;
}

/**
 * A freshly restored or created Agent that the user merely glanced at is parked shortly after they leave. The delay
 * also guards the Session's own first seconds so a restore that is still booting is not judged untouched.
 */
export const UNTOUCHED_SUSPENSION_DELAY_MS = 30_000;

export const IDLE_SUSPENSION_DELAYS_MS = {
    '2h': 2 * 60 * 60 * 1000,
    '30m': 30 * 60 * 1000,
} as const satisfies Record<Exclude<AppSettings['terminal.suspendIdleAgents'], 'off'>, number>;

const LIVE_AGENT_STATES = new Set<TerminalRecord['lastAgentProcessState']>(['running', 'starting']);

/**
 * Pure decision over the current records: which live Agent Terminals of unselected Sessions should be suspended now.
 * The selected Session is never touched, and an Agent that is mid-turn or awaiting the user's approval is left alone
 * because killing it would discard work the user has not seen.
 */
export function decideTerminalSuspensions(
    input: TerminalSuspensionPolicyInput,
): TerminalSuspensionDecision[] {
    const decisions: TerminalSuspensionDecision[] = [];
    for (const terminal of input.terminals) {
        const reason = decideTerminal(terminal, input);
        if (reason) decisions.push({ reason, terminalId: terminal.id });
    }
    return decisions;
}

function decideTerminal(
    terminal: TerminalRecord,
    input: TerminalSuspensionPolicyInput,
): TerminalSuspensionReason | undefined {
    if (!terminal.provider || terminal.lastProcessState !== 'running') return undefined;
    // A Chat has no PTY to park; its idle provider process is stopped by the Chat service instead.
    if (!isPtyTerminal(terminal)) return undefined;
    if (!agentProviderCatalog[terminal.provider].capabilities.automaticSuspension) return undefined;
    if (!LIVE_AGENT_STATES.has(terminal.lastAgentProcessState)) return undefined;
    if (terminal.sessionId === input.selectedSessionId) return undefined;
    const session = input.session(terminal.sessionId);
    if (!session || session.archivedAt !== undefined) return undefined;
    const deselectedAt = input.deselectedAt(terminal.sessionId);
    if (deselectedAt === undefined) return undefined;
    const sample = input.sample(terminal.id);
    /**
     * Activation owns the launch timestamp. While it is pending, Server age cannot prove this new Agent is idle; the
     * managed launch timeout remains responsible for a launch that never activates.
     */
    if (terminal.lastAgentProcessState === 'starting' && sample?.launchedAt === undefined)
        return undefined;
    if (sample?.turnInFlight) return undefined;
    if (
        session.primaryAgentTerminalId === terminal.id &&
        (session.lastActivityState === 'running' || session.lastActivityState === 'waiting')
    )
        return undefined;
    const sinceDeselected = input.now - deselectedAt;
    if (
        input.settings['terminal.suspendUntouchedAgents'] &&
        sample?.launchedAt !== undefined &&
        sample.lastInputAt === undefined &&
        sample.lastTurnStartedAt === undefined &&
        sinceDeselected >= UNTOUCHED_SUSPENSION_DELAY_MS &&
        input.now - sample.launchedAt >= UNTOUCHED_SUSPENSION_DELAY_MS
    )
        return 'untouched';
    const idleSetting = input.settings['terminal.suspendIdleAgents'];
    if (idleSetting === 'off') return undefined;
    const idleDelay = IDLE_SUSPENSION_DELAYS_MS[idleSetting];
    const lastActiveAt = Math.max(
        sample?.launchedAt ?? input.startedAt,
        sample?.lastInputAt ?? 0,
        sample?.lastTurnStartedAt ?? 0,
        sample?.lastTurnFinishedAt ?? 0,
    );
    if (sinceDeselected >= idleDelay && input.now - lastActiveAt >= idleDelay) return 'idle';
    return undefined;
}
