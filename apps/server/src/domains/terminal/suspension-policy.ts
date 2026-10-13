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
    /**
     * The Agent asked the user for a permission or an answer (`attentionRequested`) and nothing has resolved it yet: no
     * `attentionResolved`/`toolBatchFinished`, no new turn, and no end of turn. Such an Agent is not idle even though
     * it is not producing output, so neither automatic rule may park it.
     */
    awaitingUser?: boolean;
    launchedAt?: number;
    lastInputAt?: number;
    /**
     * Latest accepted lifecycle signal of any phase, including subagent-scoped ones that do not move the turn state.
     */
    lastSignalAt?: number;
    lastTurnFinishedAt?: number;
    lastTurnStartedAt?: number;
    turnInFlight: boolean;
}

export interface IdleSuspensionSettings {
    'terminal.idleSuspension.afterMinutes': AppSettings['terminal.idleSuspension.afterMinutes'];
    'terminal.idleSuspension.enabled': AppSettings['terminal.idleSuspension.enabled'];
    'terminal.suspendUntouchedAgents': AppSettings['terminal.suspendUntouchedAgents'];
}

export interface TerminalSuspensionPolicyInput {
    now: number;
    /**
     * When this Server process started; a launch older than the process counts as active since then for the idle rule.
     */
    startedAt: number;
    selectedSessionId: string | undefined;
    settings: IdleSuspensionSettings;
    terminals: readonly TerminalRecord[];
    deselectedAt(sessionId: string): number | undefined;
    /**
     * Whether a phone is currently observing or driving this Terminal through the mobile gateway. That is a viewer just
     * like the selected Session on the desktop, so automatic suspension leaves it alone.
     */
    isObservedRemotely(terminalId: string): boolean;
    /**
     * Whether an Agent Chat is idle enough to stop (`AgentChatService.isSuspendable`). A Chat has no activity sample of
     * a launch or Core-delivered input, so its own projection is the authority on pending work.
     */
    isChatSuspendable?(terminalId: string): boolean;
    sample(terminalId: string): TerminalActivitySample | undefined;
    session(sessionId: string): SessionRecord | undefined;
}

/**
 * A freshly restored or created Agent that the user merely glanced at is parked shortly after they leave. The delay
 * also guards the Session's own first seconds so a restore that is still booting is not judged untouched.
 */
export const UNTOUCHED_SUSPENSION_DELAY_MS = 30_000;

const MINUTE_MS = 60 * 1000;

/**
 * The configured idle window in milliseconds, or `undefined` while idle suspension is off.
 */
export function idleSuspensionDelayMs(settings: IdleSuspensionSettings): number | undefined {
    if (!settings['terminal.idleSuspension.enabled']) return undefined;
    return settings['terminal.idleSuspension.afterMinutes'] * MINUTE_MS;
}

/**
 * The most recent moment this launch showed any sign of use: launch, Core-delivered input, or an accepted lifecycle
 * signal. A launch older than this Server process counts as active since the process started.
 */
export function lastActiveAt(
    sample: TerminalActivitySample | undefined,
    startedAt: number,
): number {
    return Math.max(
        sample?.launchedAt ?? startedAt,
        sample?.lastInputAt ?? 0,
        sample?.lastSignalAt ?? 0,
        sample?.lastTurnStartedAt ?? 0,
        sample?.lastTurnFinishedAt ?? 0,
    );
}

const LIVE_AGENT_STATES = new Set<TerminalRecord['lastAgentProcessState']>(['running', 'starting']);

/**
 * Pure decision over the current records: which live Agent Terminals of unselected Sessions should be suspended now.
 * The selected Session is never touched, nor is a Terminal a phone is watching, and an Agent that is mid-turn or
 * awaiting the user's approval or answer is left alone because killing it would discard work the user has not seen. The
 * full rule set is documented in `.agents/skills/project-architecture/references/terminal-lifecycle.md`.
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
    /**
     * A Chat parks by stopping its provider process, which resumes the same Agent Session on every provider, so the
     * per-provider `automaticSuspension` capability (a PTY restore concern) does not apply. Only the idle rule does:
     * the `untouched` rule judges launch and input samples a Chat does not record.
     */
    const isChat = !isPtyTerminal(terminal);
    if (
        isChat
            ? !input.isChatSuspendable?.(terminal.id)
            : !agentProviderCatalog[terminal.provider].capabilities.automaticSuspension
    )
        return undefined;
    if (!LIVE_AGENT_STATES.has(terminal.lastAgentProcessState)) return undefined;
    if (terminal.sessionId === input.selectedSessionId) return undefined;
    if (input.isObservedRemotely(terminal.id)) return undefined;
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
    if (sample?.turnInFlight || sample?.awaitingUser) return undefined;
    if (
        session.primaryAgentTerminalId === terminal.id &&
        (session.lastActivityState === 'running' || session.lastActivityState === 'waiting')
    )
        return undefined;
    const sinceDeselected = input.now - deselectedAt;
    if (
        !isChat &&
        input.settings['terminal.suspendUntouchedAgents'] &&
        sample?.launchedAt !== undefined &&
        sample.lastInputAt === undefined &&
        sample.lastTurnStartedAt === undefined &&
        sinceDeselected >= UNTOUCHED_SUSPENSION_DELAY_MS &&
        input.now - sample.launchedAt >= UNTOUCHED_SUSPENSION_DELAY_MS
    )
        return 'untouched';
    const idleDelay = idleSuspensionDelayMs(input.settings);
    if (idleDelay === undefined) return undefined;
    if (
        sinceDeselected >= idleDelay &&
        input.now - lastActiveAt(sample, input.startedAt) >= idleDelay
    )
        return 'idle';
    return undefined;
}
