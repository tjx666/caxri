import type { AppSettings } from '@caxri/protocol';
import { agentChatIdleCompactionAt, CaxriError, errorMessage } from '@caxri/protocol';
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
 * other error, and `cache_expired` when the cache expired before the Chat was idle long enough to compact (a turn or
 * request kept it busy through the whole window).
 */
type IdleCompactionOutcome = 'cache_expired' | 'changed' | 'failed' | 'submitted' | 'unsupported';

interface Options {
    agentChat: Pick<AgentChatService, 'compactIdle' | 'idleLaunchId'> & {
        states: Pick<AgentChatService['states'], 'get' | 'terminalIds'>;
    };
    database: Pick<CaxriDatabase, 'getSession' | 'getTerminal'>;
    maintenanceTurns: Pick<AgentCoordinator['maintenanceTurns'], 'begin' | 'end' | 'holds'>;
    logger: StructuredLogger;
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
 * started for it. Like batch compaction (`SessionCompaction`), the compaction is maintenance, so its turn never reaches
 * Session state. Each response is attempted once: a compaction resets the response time, and a refused or failed one
 * waits for the next response rather than retrying every sweep.
 */
export class ChatIdleCompaction {
    /**
     * The `lastResponseAt` each Chat was last attempted (or found expired) for.
     */
    private readonly attempted = new Map<string, number>();
    private poller: WatchHandle | undefined;
    private sweeping: Promise<void> | undefined;

    constructor(private readonly options: Options) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private async runSweep(): Promise<void> {
        const terminalIds = new Set(this.options.agentChat.states.terminalIds());
        for (const terminalId of this.attempted.keys())
            if (!terminalIds.has(terminalId)) this.attempted.delete(terminalId);
        if (!this.options.settings()['agentChat.idleCompaction.enabled']) return;
        // One Chat at a time: each compaction is a provider request, and none needs to wait on another.
        await mapWithConcurrency([...terminalIds], 1, (terminalId) => this.check(terminalId));
    }

    private async check(terminalId: string): Promise<void> {
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
        const usage = agentChat.states.get(terminalId)?.projection.snapshot.usage;
        const dueAt = agentChatIdleCompactionAt(usage, provider);
        if (
            dueAt === undefined ||
            !provider ||
            usage?.lastResponseAt === undefined ||
            usage.cacheTtlMinutes === undefined
        )
            return;
        const { cacheTtlMinutes, lastResponseAt, totalTokens } = usage;
        const now = this.now();
        if (now < dueAt || this.attempted.get(terminalId) === lastResponseAt) return;
        const fields = {
            terminalId,
            provider,
            contextTokens: totalTokens,
            idleMs: now - lastResponseAt,
        };
        if (now >= lastResponseAt + cacheTtlMinutes * 60_000) {
            this.attempted.set(terminalId, lastResponseAt);
            this.options.logger.write('info', logEventCatalog.sessionCompaction.idle, {
                fields: { ...fields, outcome: 'cache_expired' satisfies IdleCompactionOutcome },
            });
            return;
        }
        // Busy (a turn, request, queued message, or a batch compaction still waiting for its turn, whose maintenance
        // window a second `begin` would supersede): look again next sweep while the cache still holds.
        const launchId = agentChat.idleLaunchId(terminalId);
        if (!launchId || this.options.maintenanceTurns.holds(terminalId)) return;
        this.attempted.set(terminalId, lastResponseAt);
        const { error, outcome } = await this.compact(terminalId, launchId);
        this.options.logger.write(
            outcome === 'failed' ? 'warn' : 'info',
            logEventCatalog.sessionCompaction.idle,
            {
                durationMs: this.now() - now,
                fields: {
                    ...fields,
                    outcome,
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
            await this.options.agentChat.compactIdle(terminalId, launchId, 'idle');
            return { outcome: 'submitted' };
        } catch (error) {
            maintenanceTurns.end(terminalId, 'undelivered');
            if (error instanceof CaxriError && error.code === 'CONFLICT')
                return { outcome: 'changed' };
            if (error instanceof CaxriError && error.code === 'VALIDATION')
                return { outcome: 'unsupported' };
            return { outcome: 'failed', error };
        }
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
