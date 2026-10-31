import type { AppSettings, SessionPullRequest } from '@caxri/protocol';
import {
    agentChatIdleCompactionAt,
    CaxriError,
    errorMessage,
    isAgentChatEndedByMerge,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, mapWithConcurrency } from '@caxri/system';

import type { AgentChatService } from '../agent-chat';
import type { AgentCoordinator } from '../agents';
import type { CaxriDatabase } from '../db';
import type { WatchHandle, WatchHub } from '../watch';

/**
 * How often live Chats are checked. Idle compaction is due for the last tenth of the cache lifetime (six minutes of a
 * one-hour cache), so a half-minute sweep always lands inside it.
 */
const IDLE_COMPACTION_SWEEP_INTERVAL_MS = 30_000;

/**
 * What one due Chat's idle compaction came to: `submitted` once the provider took the command, `changed` when the Chat
 * left its idle launch before delivery, `unsupported` when its provider lists no compact command, `failed` for any
 * other error, `cache_expired` when the cache expired before the Chat was idle long enough to compact (a turn or
 * request kept it busy through the whole window), and `pull_request_merged` when the Session's pull request merged and
 * nothing but the merge notice reached the Chat since (`isAgentChatEndedByMerge`), so the delivery is done and a next
 * message is unlikely to need the cache, and `usage_limited` when the provider's plan limit was used up, so nothing was
 * sent (the Chat's `idleCompactionHold` decides whether compaction runs after the reset).
 */
type IdleCompactionOutcome =
    | 'cache_expired'
    | 'changed'
    | 'failed'
    | 'pull_request_merged'
    | 'submitted'
    | 'unsupported'
    | 'usage_limited';

interface Options {
    agentChat: Pick<AgentChatService, 'compactIdle' | 'idleLaunchId'> & {
        states: Pick<AgentChatService['states'], 'get' | 'terminalIds'>;
    };
    database: Pick<CaxriDatabase, 'getSession' | 'getTerminal'>;
    maintenanceTurns: Pick<AgentCoordinator['maintenanceTurns'], 'begin' | 'end' | 'holds'>;
    logger: StructuredLogger;
    /**
     * The Session's last resolved pull request, read without a GitHub lookup; see `isAgentChatEndedByMerge`.
     */
    pullRequest?: (sessionId: string) => SessionPullRequest | undefined;
    settings: () => Pick<AppSettings, 'agentChat.idleCompaction.enabled'>;
    watchHub: Pick<WatchHub, 'registerPoller'>;
    now?: () => number;
    sweepIntervalMs?: number;
}

/**
 * Compacts an idle Claude or Grok Build Chat shortly before its prompt cache expires, so the user's next message
 * re-reads a summary instead of the whole conversation (`agentChatIdleCompactionAt` decides when). Claude Code does the
 * same for its own terminal sessions, which covers PTY Agents; a Chat runs Claude Code through the Agent SDK and gets
 * it from here.
 *
 * Only a Chat whose provider is running and idle in this Server Core is compacted: a stopped or suspended Chat is never
 * started for it. A Chat that ended with its Session's merged pull request is skipped: its delivery is over, so the
 * compaction would spend a provider request summarizing a conversation that most likely ends here. Like batch
 * compaction (`SessionCompaction`), the compaction is maintenance, so its turn never reaches Session state. Each
 * response is attempted once: a compaction resets the response time, and a refused or failed one waits for the next
 * response rather than retrying every sweep.
 */
export class ChatIdleCompaction {
    /**
     * The `lastResponseAt` each Chat was last attempted (or found expired) for.
     */
    private readonly attempted = new Map<string, number>();
    /**
     * The `lastResponseAt` a submitted compaction ran for, until the compaction's own response replaces it.
     */
    private readonly submittedFor = new Map<string, number>();
    /**
     * The `lastResponseAt` of each Chat's latest compaction response, which never holds the Chat from suspension.
     */
    private readonly compactionResponse = new Map<string, number>();
    private poller: WatchHandle | undefined;
    private sweeping: Promise<void> | undefined;

    constructor(private readonly options: Options) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private async runSweep(): Promise<void> {
        const terminalIds = new Set(this.options.agentChat.states.terminalIds());
        for (const entries of [this.attempted, this.submittedFor, this.compactionResponse])
            for (const terminalId of entries.keys())
                if (!terminalIds.has(terminalId)) entries.delete(terminalId);
        if (!this.options.settings()['agentChat.idleCompaction.enabled']) return;
        // One Chat at a time: each compaction is a provider request, and none needs to wait on another.
        await mapWithConcurrency([...terminalIds], 1, (terminalId) => this.check(terminalId));
    }

    /**
     * The usage that makes this Session's primary Chat eligible for idle compaction, or `undefined` when it never will
     * be for its current response (not the primary Chat, a provider that does not compact, a short cache, or a context
     * under the threshold).
     */
    private eligible(terminalId: string) {
        const { agentChat, database } = this.options;
        const terminal = database.getTerminal(terminalId);
        // Only a Session's primary Chat, as batch compaction (`SessionCompaction`) targets.
        if (
            !terminal ||
            database.getSession(terminal.sessionId)?.primaryAgentTerminalId !== terminalId
        )
            return;
        const { provider } = terminal;
        // Read from the projection directly: `AgentChatService.read` would start a stopped provider.
        const snapshot = agentChat.states.get(terminalId)?.projection.snapshot;
        const usage = snapshot?.usage;
        const dueAt = agentChatIdleCompactionAt(usage, provider, snapshot?.idleCompactionHold);
        if (
            dueAt === undefined ||
            !provider ||
            usage?.lastResponseAt === undefined ||
            usage.cacheTtlMinutes === undefined
        )
            return;
        const { cacheTtlMinutes, lastResponseAt, totalTokens } = usage;
        this.noteCompactionResponse(terminalId, lastResponseAt);
        return {
            dueAt,
            expiresAt: lastResponseAt + cacheTtlMinutes * 60_000,
            isMerged: isAgentChatEndedByMerge(
                snapshot?.items,
                this.options.pullRequest?.(terminal.sessionId),
            ),
            lastResponseAt,
            provider,
            totalTokens,
        };
    }

    /**
     * Records the first response after a submitted compaction as the compaction's own, so {@link isPending} does not
     * hold the Chat for it.
     */
    private noteCompactionResponse(terminalId: string, lastResponseAt: number): void {
        const submittedFor = this.submittedFor.get(terminalId);
        if (submittedFor === undefined || submittedFor === lastResponseAt) return;
        this.submittedFor.delete(terminalId);
        this.compactionResponse.set(terminalId, lastResponseAt);
    }

    private async check(terminalId: string): Promise<void> {
        const { agentChat } = this.options;
        const due = this.eligible(terminalId);
        if (!due) return;
        const { dueAt, expiresAt, isMerged, lastResponseAt, provider, totalTokens } = due;
        const now = this.now();
        if (now < dueAt || this.attempted.get(terminalId) === lastResponseAt) return;
        const fields = {
            terminalId,
            provider,
            contextTokens: totalTokens,
            idleMs: now - lastResponseAt,
        };
        if (isMerged || now >= expiresAt) {
            this.attempted.set(terminalId, lastResponseAt);
            const outcome: IdleCompactionOutcome = isMerged
                ? 'pull_request_merged'
                : 'cache_expired';
            this.options.logger.write('info', logEventCatalog.sessionCompaction.idle, {
                fields: { ...fields, outcome },
            });
            return;
        }
        // Busy (a turn, request, queued message, or a batch compaction still waiting for its turn, whose maintenance
        // window a second `begin` would supersede): look again next sweep while the cache still holds.
        const launchId = agentChat.idleLaunchId(terminalId);
        if (!launchId || this.options.maintenanceTurns.holds(terminalId)) return;
        this.attempted.set(terminalId, lastResponseAt);
        const { error, outcome } = await this.compact(terminalId, launchId);
        if (outcome === 'submitted') this.submittedFor.set(terminalId, lastResponseAt);
        // The hold just recorded decides from here: the next sweep compacts after the reset, or leaves the Chat alone.
        else if (outcome === 'usage_limited') this.attempted.delete(terminalId);
        this.options.logger.write(
            outcome === 'failed' ? 'warn' : 'info',
            logEventCatalog.sessionCompaction.idle,
            {
                durationMs: this.now() - now,
                fields: {
                    ...fields,
                    outcome,
                    ...(outcome === 'usage_limited' && {
                        afterReset: this.eligible(terminalId) !== undefined,
                    }),
                    ...(error !== undefined && { error: errorMessage(error, 'unknown') }),
                },
            },
        );
    }

    private async compact(
        terminalId: string,
        launchId: string,
    ): Promise<{ outcome: IdleCompactionOutcome; error?: unknown }> {
        const { maintenanceTurns } = this.options;
        // Open the window before delivery so the compaction turn it starts never reaches Session state.
        maintenanceTurns.begin(terminalId);
        try {
            if (
                (await this.options.agentChat.compactIdle(terminalId, launchId, 'idle')) ===
                'submitted'
            )
                return { outcome: 'submitted' };
            maintenanceTurns.end(terminalId, 'undelivered');
            return { outcome: 'usage_limited' };
        } catch (error) {
            maintenanceTurns.end(terminalId, 'undelivered');
            if (error instanceof CaxriError && error.code === 'CONFLICT')
                return { outcome: 'changed' };
            if (error instanceof CaxriError && error.code === 'VALIDATION')
                return { outcome: 'unsupported' };
            return { outcome: 'failed', error };
        }
    }

    /**
     * Whether this Chat's idle compaction is still to run before its cache expires: the idle-suspension rule keeps such
     * a Chat running until then (`isChatMaintenancePending`), because a suspended Chat is never started to compact. The
     * hold ends once the compaction was attempted (whatever its outcome) or the cache expired, never applies to a Chat
     * that ended with its merged pull request (there is nothing to wait for), and never covers the compaction's own
     * response, so a Chat still above the threshold afterwards is not kept one cache lifetime after another.
     */
    isPending(terminalId: string): boolean {
        if (!this.options.settings()['agentChat.idleCompaction.enabled']) return false;
        const due = this.eligible(terminalId);
        return (
            due !== undefined &&
            !due.isMerged &&
            this.now() < due.expiresAt &&
            this.attempted.get(terminalId) !== due.lastResponseAt &&
            this.compactionResponse.get(terminalId) !== due.lastResponseAt
        );
    }

    start(): void {
        this.poller = this.options.watchHub.registerPoller({
            intervalMs: this.options.sweepIntervalMs ?? IDLE_COMPACTION_SWEEP_INTERVAL_MS,
            label: 'chat-idle-compaction',
            pollOnce: () => this.sweep(),
        });
    }

    async close(): Promise<void> {
        await this.poller?.dispose();
        this.poller = undefined;
        await this.sweeping;
    }

    /**
     * One pass over the live Chats; a pass still running absorbs the next tick.
     */
    async sweep(): Promise<void> {
        if (this.sweeping) return this.sweeping;
        this.sweeping = this.runSweep();
        try {
            await this.sweeping;
        } finally {
            this.sweeping = undefined;
        }
    }
}
