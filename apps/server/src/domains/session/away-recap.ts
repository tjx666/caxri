import type {
    AgentChatSnapshot,
    AppSettings,
    ServerEvent,
    SessionPullRequest,
} from '@caxri/protocol';
import {
    AGENT_EXCERPT_MAX_LENGTH,
    agentChatAwayRecapWindow,
    agentProviderCatalog,
    isAgentChatEndedByMerge,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, mapWithConcurrency } from '@caxri/system';

import type { AgentChatService } from '../agent-chat';
import { awayRecapFailureReason } from '../agent-chat';
import type { AgentCoordinator } from '../agents';
import { toPlainLine } from '../agents';
import type { CaxriDatabase } from '../db';
import type { WatchHandle, WatchHub } from '../watch';
import type { WindowPresence } from '../window-presence';

/**
 * How often live Chats are checked. A recap is due three minutes after a reply at the latest, so a half-minute sweep
 * keeps it within a sweep of that.
 */
const AWAY_RECAP_SWEEP_INTERVAL_MS = 30_000;

/**
 * Recaps run beside each other, never more than this many at once: each is one cached model request on its own Chat.
 */
const AWAY_RECAP_CONCURRENCY = 2;

/**
 * Why a reply was skipped: `brief_reply` when it was a short answer with no tool work (the Activity excerpt already
 * quotes all of it), `cache_expired` when the Chat stayed busy or stopped until its cache was too cold to read cheaply,
 * `pull_request_merged` when the Session's delivery ended with its merged pull request.
 */
type AwayRecapSkip = 'brief_reply' | 'cache_expired' | 'pull_request_merged';

/**
 * Whether the latest turn was a short answer with no tool work: everything after the last user message is Agent text
 * (or reasoning) that fits in an Activity excerpt, so a recap would only repeat it.
 */
export function isBriefAgentChatReply(items: AgentChatSnapshot['items']): boolean {
    let length = 0;
    for (let index = items.length - 1; index >= 0; index--) {
        const item = items[index];
        if (item.type === 'userMessage') return true;
        if (item.type === 'reasoning' || item.type === 'notice') continue;
        if (item.type !== 'agentMessage') return false;
        length += [...toPlainLine(item.text)].length;
        if (length > AGENT_EXCERPT_MAX_LENGTH) return false;
    }
    // No user message in view: the turn reaches back past the projection, which no short answer does.
    return false;
}

interface Options {
    agentChat: Pick<AgentChatService, 'idleLaunchId' | 'isObservedRemotely' | 'recapAway'> & {
        states: Pick<AgentChatService['states'], 'get' | 'terminalIds'>;
    };
    database: Pick<CaxriDatabase, 'getSession' | 'getTerminal'>;
    maintenanceTurns: Pick<AgentCoordinator['maintenanceTurns'], 'holds'>;
    logger: StructuredLogger;
    presence: Pick<WindowPresence, 'isSettled' | 'watchedSessionId'>;
    /**
     * The Session's last resolved pull request, read without a GitHub lookup; see `isAgentChatEndedByMerge`.
     */
    pullRequest?: (sessionId: string) => SessionPullRequest | undefined;
    /**
     * Announces a new recap (`agent.recapChanged`) so Activity re-reads its excerpt.
     */
    send(event: ServerEvent): void;
    settings: () => Pick<AppSettings, 'agentChat.awayRecap.enabled'>;
    watchHub: Pick<WatchHub, 'registerPoller'>;
    now?: () => number;
    sweepIntervalMs?: number;
}

/**
 * Generates a short recap of a Chat that replied while the user was away, after Claude Code's recap on return. The
 * recap is a tool-less side question (`AgentChatService.recapAway`), so nothing is added to the conversation or the
 * Agent's instructions; it lands on the Chat projection (`awayRecap`) and Activity quotes it in place of the reply.
 *
 * A reply gets at most one recap, and only when all of these hold once it is due (`agentChatAwayRecapWindow`): the user
 * did not see it land (the Session is not watched in a focused window or on a phone, and was last left before the
 * reply), the Chat is the Session's primary one and its provider is running and idle, its prompt cache is still warm,
 * and the reply was more than a brief answer. A Chat that is busy or stopped is looked at again on the next sweep until
 * its cache cools. Until then idle suspension keeps the Chat running ({@link isPending}), because a stopped provider
 * cannot answer a side question.
 */
export class ChatAwayRecap {
    /**
     * The `lastResponseAt` each Chat's recap was decided for (generated, skipped, failed, or seen by the user).
     */
    private readonly settled = new Map<string, number>();
    private poller: WatchHandle | undefined;
    private sweeping: Promise<void> | undefined;

    constructor(private readonly options: Options) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private async runSweep(): Promise<void> {
        const terminalIds = new Set(this.options.agentChat.states.terminalIds());
        for (const terminalId of this.settled.keys())
            if (!terminalIds.has(terminalId)) this.settled.delete(terminalId);
        if (!this.options.settings()['agentChat.awayRecap.enabled']) return;
        // Before Desktop reports presence, nobody is known to be away.
        if (!this.options.presence.isSettled()) return;
        await mapWithConcurrency([...terminalIds], AWAY_RECAP_CONCURRENCY, (terminalId) =>
            this.check(terminalId),
        );
    }

    /**
     * The reply this Chat could still get a recap for, or `undefined`: not a Session's primary Chat, a provider without
     * side questions, no reply yet, or a reply already recapped or decided.
     */
    private candidate(terminalId: string) {
        const { agentChat, database } = this.options;
        const terminal = database.getTerminal(terminalId);
        if (!terminal?.provider) return;
        const session = database.getSession(terminal.sessionId);
        if (session?.primaryAgentTerminalId !== terminalId) return;
        if (!agentProviderCatalog[terminal.provider].capabilities.chatSideQuestion) return;
        // Read from the projection directly: `AgentChatService.read` would start a stopped provider.
        const snapshot = agentChat.states.get(terminalId)?.projection.snapshot;
        const window = agentChatAwayRecapWindow(snapshot?.usage);
        const lastResponseAt = snapshot?.usage?.lastResponseAt;
        if (!snapshot || !window || lastResponseAt === undefined) return;
        if (snapshot.awayRecap?.lastResponseAt === lastResponseAt) return;
        if (this.settled.get(terminalId) === lastResponseAt) return;
        return { lastResponseAt, provider: terminal.provider, session, snapshot, ...window };
    }

    private async check(terminalId: string): Promise<void> {
        const { agentChat, presence } = this.options;
        const due = this.candidate(terminalId);
        if (!due) return;
        const { dueAt, lastResponseAt, provider, session, snapshot, staleAt } = due;
        const now = this.now();
        if (now < dueAt) return;
        const settle = () => this.settled.set(terminalId, lastResponseAt);
        // The user saw the reply land: they are looking now, or left the Session only after it arrived.
        if (
            presence.watchedSessionId() === session.id ||
            agentChat.isObservedRemotely(terminalId) ||
            (session.lastViewedAt !== undefined && session.lastViewedAt >= lastResponseAt)
        ) {
            settle();
            return;
        }
        const fields = { terminalId, provider, awayMs: now - lastResponseAt };
        const skip = (reason: AwayRecapSkip) => {
            settle();
            this.options.logger.write('info', logEventCatalog.agentChat.awayRecap, {
                fields: { ...fields, outcome: 'skipped', reason, length: null },
            });
        };
        if (isAgentChatEndedByMerge(snapshot.items, this.options.pullRequest?.(session.id))) {
            skip('pull_request_merged');
            return;
        }
        if (isBriefAgentChatReply(snapshot.items)) {
            skip('brief_reply');
            return;
        }
        if (staleAt !== undefined && now >= staleAt) {
            skip('cache_expired');
            return;
        }
        // Busy (a turn, request, or queued message), stopped, or compacting: look again next sweep while the cache holds.
        if (!agentChat.idleLaunchId(terminalId) || this.options.maintenanceTurns.holds(terminalId))
            return;
        settle();
        try {
            const text = await agentChat.recapAway(terminalId, lastResponseAt);
            this.options.send({ event: 'agent.recapChanged', payload: { sessionId: session.id } });
            this.options.logger.write('info', logEventCatalog.agentChat.awayRecap, {
                durationMs: this.now() - now,
                fields: { ...fields, outcome: 'generated', reason: null, length: [...text].length },
            });
        } catch (error) {
            this.options.logger.write('warn', logEventCatalog.agentChat.awayRecap, {
                durationMs: this.now() - now,
                fields: {
                    ...fields,
                    outcome: 'failed',
                    reason: awayRecapFailureReason(error),
                    length: null,
                },
            });
        }
    }

    /**
     * Whether this Chat's latest reply may still get a recap: the idle-suspension rule keeps such a Chat running
     * (`isChatMaintenancePending`), because a suspended Chat is never started for a recap. The hold ends once the recap
     * was decided or the cache cooled, so it never outlasts the reply's cache.
     */
    isPending(terminalId: string): boolean {
        if (!this.options.settings()['agentChat.awayRecap.enabled']) return false;
        const due = this.candidate(terminalId);
        return due !== undefined && (due.staleAt === undefined || this.now() < due.staleAt);
    }

    start(): void {
        this.poller = this.options.watchHub.registerPoller({
            intervalMs: this.options.sweepIntervalMs ?? AWAY_RECAP_SWEEP_INTERVAL_MS,
            label: 'chat-away-recap',
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
