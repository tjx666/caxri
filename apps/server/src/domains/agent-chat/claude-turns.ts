import { randomUUID } from 'node:crypto';

import type { SDKRateLimitInfo, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentChatSnapshot, AgentChatTurn } from '@caxri/protocol';

import { shellCommandMatchesAny } from '../agents';
import { startedTurnOperation } from './chat-items';
import type { AgentChatSessionHost } from './chat-provider';
import { chatTextDigest, chatTurnFinalMessage } from './chat-turn-answer';
import { claudeContextWindow, finishedClaudeTurn } from './claude-items';
import { claudeRateLimitEvent } from './claude-plan-limits';
import { ClaudeUsageLimitTracker } from './continuation/claude-usage-limit';

/**
 * Whether background work that holds the turn is still running: a subagent or workflow (both listed as `agent`), or a
 * background shell whose command matches none of `longRunning`. A shell matching one, such as a dev server, can run for
 * hours; without `longRunning`, or for a shell whose command is unknown, no shell holds the turn.
 */
function hasWakingBackgroundWork(
    snapshot: AgentChatSnapshot,
    longRunning: readonly string[] | undefined,
    shellCommand: ((taskId: string) => string | undefined) | undefined,
): boolean {
    return (snapshot.tasks ?? []).some((task) => {
        if (!task.isBackground || task.status !== 'running') return false;
        if (task.kind === 'agent') return true;
        if (longRunning === undefined) return false;
        const command = shellCommand?.(task.id);
        return command !== undefined && !shellCommandMatchesAny(command, longRunning);
    });
}

/**
 * Turn state of one Claude Code Chat. Claude Code has no turn ids: a turn this session starts is identified by the uuid
 * of its user message, and ends with the `result` message once no queued message is left to fold in.
 * `system/session_state_changed` is the authoritative boundary: Claude Code also starts turns on its own (a background
 * task finishing wakes the main thread), which get a synthetic id so the Chat shows them and holds queued input back.
 */
export class ClaudeTurns {
    /**
     * Whether Claude Code reported `running` for the current turn. A turn this session started waits for it, so the
     * `idle` that closes the previous turn, arriving after the next prompt went out, cannot end the new turn.
     */
    private isAcknowledged = false;

    private contextWindowSize: number | undefined;

    /**
     * The completed turn whose finish was reported with background work still running. Its plain finish is reported
     * again once that work drains, unless Claude Code resumes with a new turn first.
     */
    private backgroundTurnId: string | undefined;

    /**
     * The plan limits Claude Code last reported as used up, which a failing turn ran into.
     */
    private readonly usageLimits = new ClaudeUsageLimitTracker();

    isInterruptRequested = false;

    count = 0;

    constructor(
        private readonly options: {
            host: AgentChatSessionHost;
            /**
             * Binds the Agent Session on its first turn, and returns its id.
             */
            bindSession: () => string;
            sessionId: () => string;
            /**
             * Settles requests still pending when a turn ends.
             */
            settleRequests: () => void;
            /**
             * The command line of a listed background shell, when its Bash row is known. A shell's title may be the
             * Agent's description of it instead.
             */
            shellCommand?: (taskId: string) => string | undefined;
        },
    ) {}

    /**
     * Ends the active turn, from its `result` or, when no result closed it, from Claude Code reporting `idle`.
     */
    private end(outcome: 'completed' | 'failed', error: string | undefined): void {
        const { host } = this.options;
        const snapshot = host.read();
        const id = snapshot.activeTurnId;
        if (!id) return;
        const status: AgentChatTurn['status'] = this.isInterruptRequested ? 'interrupted' : outcome;
        this.isInterruptRequested = false;
        this.options.settleRequests();
        const usageLimit = status === 'failed' ? this.usageLimits.current() : undefined;
        const finished = finishedClaudeTurn(
            host.read(),
            id,
            status,
            // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- an empty error carries no detail either
            error || 'Claude could not finish this turn',
            usageLimit,
        );
        host.apply(finished.operations);
        if (this.contextWindowSize && snapshot.usage)
            host.apply([
                {
                    op: 'state',
                    state: { usage: { ...snapshot.usage, contextWindow: this.contextWindowSize } },
                },
            ]);
        host.onTurnFinished(status, finished.durationMs, id);
        const agentSessionId = this.options.sessionId();
        const isWaitingOnBackground =
            status === 'completed' &&
            hasWakingBackgroundWork(
                host.read(),
                host.longRunningShellCommands?.(),
                this.options.shellCommand,
            );
        this.backgroundTurnId = isWaitingOnBackground ? id : undefined;
        const answer = status === 'completed' ? chatTurnFinalMessage(host.read(), id) : undefined;
        host.lifecycle(
            status === 'failed'
                ? {
                      phase: 'turnFailed',
                      agentSessionId,
                      agentTurnId: id,
                      // A used-up plan limit is the lifecycle's `quota_exhausted` failure, which `billing_error` maps to.
                      agentFailure: usageLimit ? 'billing_error' : 'provider_failed',
                  }
                : {
                      phase: 'turnFinished',
                      agentSessionId,
                      agentTurnId: id,
                      ...(answer && { agentResponseDigest: chatTextDigest(answer.text) }),
                      ...(isWaitingOnBackground && { agentBackgroundWork: true as const }),
                  },
        );
    }

    /**
     * One `rate_limit_event`: remembers a used-up window for the turn it fails, and reports the window to the host for
     * the account's weekly usage guard.
     */
    observeRateLimit(info: SDKRateLimitInfo): void {
        this.usageLimits.observe(info);
        const reading = claudeRateLimitEvent({ observedAt: 0, windows: [] }, info, Date.now());
        if (reading) this.options.host.observePlanLimits?.(reading);
    }

    /**
     * Whether an assistant message is Claude Code's synthetic reply to a used-up plan limit ("You've hit your session
     * limit"). It fails the turn with the same text right after, and the turn's error notice carries it with the
     * structured limit, so the reply is not shown a second time as if the model had said it.
     */
    isUsageLimitReply(error: string | undefined): boolean {
        return error === 'rate_limit' && this.usageLimits.current() !== undefined;
    }

    get contextWindow(): number | undefined {
        return this.contextWindowSize;
    }

    /**
     * Opens a turn. `prompt` is the exact text of the message that starts it, digested at this moment rather than when
     * it was sent, because a message sent during a turn waits in the Chat's queue until that turn ends.
     */
    begin(
        id: string,
        { isOwnPrompt = false, prompt }: { isOwnPrompt?: boolean; prompt?: string } = {},
    ): void {
        const { host } = this.options;
        const snapshot = host.read();
        const sessionId = this.options.bindSession();
        if (isOwnPrompt) this.isAcknowledged = false;
        this.backgroundTurnId = undefined;
        this.count += 1;
        this.isInterruptRequested = false;
        host.apply([startedTurnOperation(snapshot, id)]);
        host.lifecycle({
            phase: 'turnStarted',
            agentSessionId: sessionId,
            agentTurnId: id,
            ...(prompt !== undefined && { agentPromptDigest: chatTextDigest(prompt) }),
        });
    }

    /**
     * Opens a synthetic turn for model output that arrives while no turn is active: Claude Code started a turn on its
     * own without a `running` state change this session saw (an older CLI, or no `idle` in between).
     */
    ensure(): void {
        if (!this.options.host.read().activeTurnId) this.begin(`auto:${randomUUID()}`);
    }

    finish(result: SDKResultMessage): void {
        const usageWindow = claudeContextWindow(result.modelUsage);
        if (usageWindow) this.contextWindowSize = usageWindow;
        // A message sent during the turn is folded into it; the turn ends with the last result.
        if ((result.queued_turn_count ?? 0) > 0) return;
        const isSuccess = result.subtype === 'success' && !result.is_error;
        const error =
            result.subtype === 'success' ? result.result : result.errors.filter(Boolean).join('\n');
        this.end(isSuccess ? 'completed' : 'failed', error);
    }

    /**
     * Reports the waiting turn's plain finish once its background work drained while no turn runs. The shared lifecycle
     * path still waits a short resume window, because Claude Code usually starts a turn on its own to report the
     * result.
     */
    onTasksChanged(): void {
        const id = this.backgroundTurnId;
        const snapshot = this.options.host.read();
        if (
            !id ||
            snapshot.activeTurnId ||
            hasWakingBackgroundWork(
                snapshot,
                this.options.host.longRunningShellCommands?.(),
                this.options.shellCommand,
            )
        )
            return;
        this.backgroundTurnId = undefined;
        this.options.host.lifecycle({
            phase: 'turnFinished',
            agentSessionId: this.options.sessionId(),
            agentTurnId: id,
        });
    }

    onSessionState(state: unknown): void {
        if (state === 'running') {
            this.isAcknowledged = true;
            this.ensure();
            return;
        }
        if (state !== 'idle' || !this.isAcknowledged) return;
        this.isAcknowledged = false;
        this.end('completed', undefined);
    }
}
