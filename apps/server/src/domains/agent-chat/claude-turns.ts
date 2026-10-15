import { randomUUID } from 'node:crypto';

import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentChatSnapshot, AgentChatTurn } from '@caxri/protocol';

import { MAX_TRACKED_TURNS } from './chat-items';
import type { AgentChatSessionHost } from './chat-provider';
import { chatTextDigest, chatTurnFinalMessage } from './chat-turn-answer';
import { ChatTurnInterruption } from './chat-turn-interruption';
import { finishedChatLifecycle } from './chat-turn-lifecycle';
import { isClaudeCompactCommand } from './claude-input';
import { claudeContextWindow, finishedClaudeTurn } from './claude-items';

/**
 * Whether background work that wakes Claude again is still running: a subagent or workflow (both listed as `agent`). A
 * background shell does not count; it can be a dev server that runs for hours.
 */
function hasWakingBackgroundWork(snapshot: AgentChatSnapshot): boolean {
    return (snapshot.tasks ?? []).some(
        (task) => task.kind === 'agent' && task.isBackground && task.status === 'running',
    );
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
    private isMaintenanceTurn = false;

    private contextWindowSize: number | undefined;

    /**
     * The completed turn whose finish was reported with background work still running. Its plain finish is reported
     * again once that work drains, unless Claude Code resumes with a new turn first.
     */
    private backgroundTurnId: string | undefined;

    private readonly userInterruption = new ChatTurnInterruption();

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
        const interruptionReason = this.interruptionReason;
        const status: AgentChatTurn['status'] = interruptionReason ? 'interrupted' : outcome;
        this.userInterruption.clear();
        this.options.settleRequests();
        const finished = finishedClaudeTurn(
            host.read(),
            id,
            status,
            // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- an empty error carries no detail either
            error || 'Claude could not finish this turn',
            interruptionReason,
        );
        host.apply(finished.operations);
        if (this.contextWindowSize && snapshot.usage)
            host.apply([
                {
                    op: 'state',
                    state: { usage: { ...snapshot.usage, contextWindow: this.contextWindowSize } },
                },
            ]);
        host.onTurnFinished(status, finished.durationMs);
        const agentSessionId = this.options.sessionId();
        const isWaitingOnBackground =
            status === 'completed' && hasWakingBackgroundWork(host.read());
        this.backgroundTurnId = isWaitingOnBackground ? id : undefined;
        const answer = status === 'completed' ? chatTurnFinalMessage(host.read(), id) : undefined;
        const isMaintenance = this.isMaintenanceTurn;
        this.isMaintenanceTurn = false;
        host.lifecycle(
            finishedChatLifecycle(status, {
                agentSessionId,
                agentTurnId: id,
                ...(isMaintenance && { activity: 'maintenance' }),
                ...(answer && { agentResponseDigest: chatTextDigest(answer.text) }),
                ...(isWaitingOnBackground && { agentBackgroundWork: true }),
            }),
        );
    }

    get contextWindow(): number | undefined {
        return this.contextWindowSize;
    }

    requestInterrupt(): (() => void) | undefined {
        const turnId = this.options.host.read().activeTurnId;
        return turnId ? this.userInterruption.request(turnId) : undefined;
    }

    get interruptionReason(): AgentChatTurn['interruptionReason'] {
        return this.userInterruption.reason(this.options.host.read().activeTurnId);
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
        this.isMaintenanceTurn = prompt !== undefined && isClaudeCompactCommand(prompt);
        this.count += 1;
        this.userInterruption.clear();
        host.apply([
            {
                op: 'state',
                state: {
                    turns: [
                        ...snapshot.turns,
                        { id, status: 'running' as const, startedAt: Date.now() },
                    ].slice(-MAX_TRACKED_TURNS),
                    activeTurnId: id,
                    plan: null,
                },
            },
        ]);
        host.lifecycle({
            phase: 'turnStarted',
            ...(this.isMaintenanceTurn && { activity: 'maintenance' }),
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
        /**
         * A successful result that raced Stop still completed normally.
         */
        if (isSuccess) this.userInterruption.clear();
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
        if (!id || snapshot.activeTurnId || hasWakingBackgroundWork(snapshot)) return;
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
