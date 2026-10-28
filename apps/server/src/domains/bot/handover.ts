import { randomUUID } from 'node:crypto';

import type {
    BotConversation,
    BotConversationReference,
    BotHandover,
    BotHandoverOutcome,
    BotHandoverOwnershipReason,
    BotHandoverRejection,
    BotHandoverRequest,
    BotHandoverResult,
    BotInputTakeBack,
    BotManagedSessions,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import {
    CaxriError,
    delegationProviderSchema,
    isChatTerminal,
    isTopLevelProject,
    logEventCatalog,
    MAX_BOT_CONVERSATIONS,
    MAX_BOT_INPUT_TAKE_BACKS,
    MAX_BOT_TASKS,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import { canChatCorrelateTask } from '../agent-delegation';
import type { CaxriDatabase } from '../db';
import type { WorktreeTopologyReader } from '../session';
import { conversationProject, importExternalConversation } from '../session';
import { botHandovers, isHandoverTargetBusy, writeBotHandovers } from './handover-records';
import type { BotHandoverNoticeEvent } from './notice-text';

/**
 * Mirrors `createBotSession`'s cap, so a hand-over can never grow the ownership record past what Caxri Bot could have
 * created itself.
 */
const MAX_BOT_SESSIONS = 1_000;

/**
 * One external conversation as the provider discovery reports it, before it is matched to a Project.
 */
export type DiscoveredConversation = Omit<BotConversation, 'projectId'>;

export interface BotHandoverServiceOptions {
    database: CaxriDatabase;
    /**
     * Agent conversations in the providers' own history that no Terminal binds, newest first. Optional so a unit test
     * can omit provider discovery.
     */
    discoverConversations?(
        boundProviderSessionIds: ReadonlySet<string>,
    ): Promise<DiscoveredConversation[]>;
    logger?: StructuredLogger;
    now?: () => number;
    /**
     * Queues the content-free line that tells Caxri Bot about a hand-over; see `BotCompletionNotifier`.
     */
    notify(entry: { event: BotHandoverNoticeEvent; handoverId: string; sessionId: string }): void;
    /**
     * Resolves a folder to the root of the Project that should own it: the repository root of a worktree, the folder
     * itself otherwise. Rejects a folder that no longer exists.
     */
    resolveProjectRoot(path: string): Promise<string>;
    /**
     * Places a conversation run in a linked worktree under the Project that owns it.
     */
    readTopology?: WorktreeTopologyReader;
    sendFullStateChange(): void;
}

function primaryAgent(
    session: SessionRecord,
    terminals: readonly TerminalRecord[],
): TerminalRecord | undefined {
    return terminals.find(
        (terminal) => terminal.id === session.primaryAgentTerminalId && terminal.kind !== 'shell',
    );
}

/**
 * Why a Session's Agent conversation cannot be continued by Caxri Bot, if it cannot. A Chat qualifies like a PTY Agent
 * when its provider's Chat can correlate a Caxri Bot task (see `canChatCorrelateTask`): the continuation reaches its
 * conversation through the Chat's own send chain or a Chat restart.
 */
function ownershipReason(
    terminal: TerminalRecord | undefined,
): BotHandoverOwnershipReason | undefined {
    if (!terminal?.provider) return 'agent_missing';
    if (isChatTerminal(terminal) && !canChatCorrelateTask(terminal.provider)) return 'chat_surface';
    if (!delegationProviderSchema.safeParse(terminal.provider).success)
        return 'provider_unsupported';
    if (!terminal.agentSessionId) return 'provider_session_missing';
    return undefined;
}

function conversationKey(conversation: BotConversationReference): string {
    return `${conversation.provider}:${conversation.providerSessionId}`;
}

/**
 * The user's side of Caxri Bot ownership: handing Sessions (or Agent conversations started outside Caxri) to the Caxri
 * Bot, taking them back, and noticing when the user takes one back by typing into its Agent. Caxri Bot can never call
 * these; see `botHandoverMethods`.
 */
export class BotHandoverService {
    private readonly now: () => number;
    /**
     * Agent Terminals of current hand-overs, so the per-keystroke input hook answers in constant time.
     */
    private targets = new Map<string, string>();
    /**
     * Hand-overs whose Agent was mid-turn when handed over, by Agent Terminal: Caxri Bot gets `ready` once it finishes.
     * In memory only; `requeue` rebuilds the notices for a relaunched Caxri Bot.
     */
    private readonly awaitingReady = new Map<string, BotHandover>();
    /**
     * Recent take-backs caused by typing, oldest first, for the Workbench's notice; see `botManagedSessionsSchema` for
     * why they are read rather than pushed. Memory only, bounded by `MAX_BOT_INPUT_TAKE_BACKS`.
     */
    private inputTakeBacks: BotInputTakeBack[] = [];

    constructor(private readonly options: BotHandoverServiceOptions) {
        this.now = options.now ?? Date.now;
        this.refreshTargets();
    }

    private refreshTargets(): void {
        this.targets = new Map(
            botHandovers(this.options.database).flatMap((handover) =>
                handover.target ? [[handover.target.terminalId, handover.sessionId]] : [],
            ),
        );
        for (const terminalId of this.awaitingReady.keys())
            if (!this.targets.has(terminalId)) this.awaitingReady.delete(terminalId);
    }

    private boundProviderSessionIds(): Set<string> {
        return new Set(
            this.options.database
                .listTerminals()
                .flatMap((terminal) => (terminal.agentSessionId ? [terminal.agentSessionId] : [])),
        );
    }

    private announce(handover: BotHandover): void {
        const { database } = this.options;
        const terminal = handover.target && database.getTerminal(handover.target.terminalId);
        const event: BotHandoverNoticeEvent = !handover.target
            ? 'ownership_only'
            : isHandoverTargetBusy(database.getSession(handover.sessionId), terminal)
              ? 'busy'
              : 'ready';
        if (event === 'busy' && handover.target)
            this.awaitingReady.set(handover.target.terminalId, handover);
        this.options.notify({ event, handoverId: handover.id, sessionId: handover.sessionId });
    }

    private async importConversations(
        conversations: readonly BotConversationReference[],
        batch: {
            reject(
                reason: BotHandoverRejection,
                entry: { conversation: BotConversationReference },
            ): void;
            hasCapacity(entry: { conversation: BotConversationReference }): boolean;
            accept(
                session: SessionRecord,
                source: 'conversation',
                terminal: TerminalRecord,
                conversation: BotConversationReference,
            ): void;
        },
    ): Promise<void> {
        const bound = this.boundProviderSessionIds();
        /**
         * Discovery runs again rather than trusting the request: only a conversation the providers' own history still
         * holds, in a folder that still exists, may become a Session.
         */
        const discovered = new Map(
            ((await this.options.discoverConversations?.(bound)) ?? []).map((conversation) => [
                conversationKey(conversation),
                conversation,
            ]),
        );
        const seen = new Set<string>();
        for (const conversation of conversations) {
            const key = conversationKey(conversation);
            const found = discovered.get(key);
            if (seen.has(key)) batch.reject('duplicate', { conversation });
            else if (bound.has(conversation.providerSessionId))
                batch.reject('conversation_bound', { conversation });
            else if (!found) batch.reject('conversation_missing', { conversation });
            else if (batch.hasCapacity({ conversation })) {
                // eslint-disable-next-line no-await-in-loop -- an import may add the Project the next one resolves into
                const imported = await this.importConversation(found);
                if (imported) {
                    bound.add(conversation.providerSessionId);
                    batch.accept(imported.session, 'conversation', imported.terminal, conversation);
                } else batch.reject('conversation_missing', { conversation });
            }
            seen.add(key);
        }
    }

    private importConversation(
        conversation: DiscoveredConversation,
    ): Promise<{ session: SessionRecord; terminal: TerminalRecord } | undefined> {
        return importExternalConversation(
            this.options.database,
            conversation,
            (path) => this.options.resolveProjectRoot(path),
            this.options.readTopology,
        );
    }

    private finish(
        outcomes: BotHandoverOutcome[],
        added: readonly BotHandover[],
    ): BotHandoverResult {
        const rejected = outcomes.flatMap((outcome) =>
            outcome.outcome === 'rejected' ? [outcome.reason] : [],
        );
        this.options.logger?.write('info', logEventCatalog.caxriBot.sessionsHandedOver, {
            fields: {
                accepted: added.length,
                rejected: rejected.length,
                reasons: [...new Set(rejected)].join(','),
                conversations: added.filter((handover) => handover.source === 'conversation')
                    .length,
                ownershipOnly: added.filter((handover) => !handover.target).length,
            },
        });
        for (const handover of added) {
            this.options.logger?.write('info', logEventCatalog.caxriBot.taskRecorded, {
                fields: { taskId: handover.taskId ?? null, delegationId: null, origin: 'handover' },
            });
            this.announce(handover);
        }
        if (added.length > 0) this.options.sendFullStateChange();
        return { outcomes };
    }

    /**
     * Agent conversations the user may hand over, newest first, each matched to the Project that would own it.
     */
    async conversations(): Promise<{ conversations: BotConversation[] }> {
        const discovered =
            (await this.options.discoverConversations?.(this.boundProviderSessionIds())) ?? [];
        const projects = this.options.database.listVisibleProjects();
        return {
            conversations: await Promise.all(
                discovered.slice(0, MAX_BOT_CONVERSATIONS).map(async (conversation) => ({
                    ...conversation,
                    projectId: (await conversationProject(projects, conversation.cwd))?.id ?? null,
                })),
            ),
        };
    }

    managedSessions(): BotManagedSessions {
        const rows = this.options.database.caxriBotRows();
        return {
            sessionIds: [...(rows?.sessionIds ?? [])],
            ...(rows && { botSessionId: rows.sessionId }),
            inputTakeBackSessionIds: [...new Set(this.targets.values())],
            chatTakeBackSessionIds: [
                ...new Set(
                    [...this.targets].flatMap(([terminalId, sessionId]) => {
                        const terminal = this.options.database.getTerminal(terminalId);
                        return terminal && isChatTerminal(terminal) ? [sessionId] : [];
                    }),
                ),
            ],
            inputTakeBacks: [...this.inputTakeBacks],
        };
    }

    /**
     * Hands every entry over on its own: a refused entry never blocks the rest. Conversations are imported into a new
     * Session first, adding their folder as a Project when no visible Project contains it.
     */
    async handOver(request: BotHandoverRequest): Promise<BotHandoverResult> {
        const { database } = this.options;
        const sessionIds = request.sessionIds ?? [];
        const conversations = request.conversations ?? [];
        const outcomes: BotHandoverOutcome[] = [];
        const reject = (
            reason: BotHandoverRejection,
            entry: { sessionId?: string; conversation?: BotConversationReference },
        ) => outcomes.push({ outcome: 'rejected', reason, ...entry });
        const rows = database.caxriBotRows();
        if (!rows) {
            for (const sessionId of sessionIds) reject('bot_unavailable', { sessionId });
            for (const conversation of conversations) reject('bot_unavailable', { conversation });
            return this.finish(outcomes, []);
        }
        const added: BotHandover[] = [];
        /**
         * Read from the database on every check, never from a snapshot taken at the start: conversation discovery and
         * Project resolution await, and a concurrent hand-over or take-back may commit meanwhile. This call's own
         * entries count too, because its ownership write happens only once the whole batch is decided.
         */
        const currentRows = () => database.caxriBotRows() ?? rows;
        const currentOwned = () =>
            new Set([...currentRows().sessionIds, ...added.map((entry) => entry.sessionId)]);
        const hasCapacity = (entry: {
            sessionId?: string;
            conversation?: BotConversationReference;
        }) => {
            if (currentOwned().size >= MAX_BOT_SESSIONS) reject('ownership_capacity', entry);
            else if (database.botTasks.countOpen() >= MAX_BOT_TASKS) reject('task_capacity', entry);
            else return true;
            return false;
        };
        const accept = (
            session: SessionRecord,
            source: BotHandover['source'],
            terminal: TerminalRecord | undefined,
            conversation?: BotConversationReference,
        ) => {
            const reason = ownershipReason(terminal);
            const task = database.botTasks.insert(
                {
                    title: session.title.trim().slice(0, 200) || 'Handed-over Session',
                    status: 'pending',
                    projectId: session.projectId,
                    sessionId: session.id,
                    ...(request.note && { note: request.note }),
                },
                this.now(),
            );
            const handover: BotHandover = {
                id: randomUUID(),
                projectId: session.projectId,
                sessionId: session.id,
                source,
                ...(reason
                    ? { ownershipReason: reason }
                    : {
                          target: {
                              terminalId: terminal!.id,
                              provider: delegationProviderSchema.parse(terminal!.provider),
                              providerSessionId: terminal!.agentSessionId!,
                          },
                      }),
                taskId: task.id,
                createdAt: this.now(),
            };
            added.push(handover);
            outcomes.push({
                outcome: 'accepted',
                sessionId: session.id,
                handoverId: handover.id,
                taskId: task.id,
                ...(reason && { ownershipReason: reason }),
                ...(conversation && { conversation }),
            });
        };
        if (conversations.length > 0)
            await this.importConversations(conversations, { reject, hasCapacity, accept });
        /**
         * Existing Sessions are decided only after the last await, so the checks below and the ownership write that
         * follows run in one synchronous step. Deciding them before discovery let a concurrent hand-over of the same
         * Session commit in between, and both calls then recorded a hand-over and a pending task for it.
         */
        const visibleProjects = new Set(
            database
                .listVisibleProjects()
                .filter((project) => isTopLevelProject(project))
                .map((project) => project.id),
        );
        const botSessionId = currentRows().sessionId;
        const seen = new Set<string>();
        for (const sessionId of sessionIds) {
            const session = database.getSession(sessionId);
            if (seen.has(sessionId)) reject('duplicate', { sessionId });
            else if (!session) reject('session_missing', { sessionId });
            else if (session.archivedAt !== undefined) reject('session_archived', { sessionId });
            else if (sessionId === botSessionId) reject('bot_session', { sessionId });
            else if (!visibleProjects.has(session.projectId))
                reject('project_unavailable', { sessionId });
            else if (currentOwned().has(sessionId)) reject('already_managed', { sessionId });
            else if (hasCapacity({ sessionId }))
                accept(
                    session,
                    'session',
                    primaryAgent(session, database.listTerminals(sessionId)),
                );
            seen.add(sessionId);
        }
        if (added.length > 0) {
            const current = currentRows();
            database.setAppState('caxriBot', {
                projectId: current.projectId,
                sessionId: current.sessionId,
                ...(current.terminalId && { terminalId: current.terminalId }),
                sessionIds: [
                    ...new Set([...current.sessionIds, ...added.map((entry) => entry.sessionId)]),
                ],
            });
            writeBotHandovers(database, [...botHandovers(database), ...added]);
            this.refreshTargets();
        }
        return this.finish(outcomes, added);
    }

    /**
     * Removes a Session from Caxri Bot's management. Its Agents keep running; tasks Caxri Bot already started there
     * keep their receipts, but Caxri Bot can no longer start or continue one, and the hand-over's own task is dropped
     * while it is still pending.
     */
    takeBack(
        sessionId: string,
        reason: 'take_back' | 'human_input' = 'take_back',
    ): { sessionId: string; outcome: 'taken_back' | 'not_managed' } {
        const { database } = this.options;
        const rows = database.caxriBotRows();
        if (!database.getSession(sessionId)) throw new CaxriError('NOT_FOUND', 'Session not found');
        if (!rows?.sessionIds.includes(sessionId)) return { sessionId, outcome: 'not_managed' };
        const handover = botHandovers(database).find((entry) => entry.sessionId === sessionId);
        database.setAppState('caxriBot', {
            projectId: rows.projectId,
            sessionId: rows.sessionId,
            ...(rows.terminalId && { terminalId: rows.terminalId }),
            sessionIds: rows.sessionIds.filter((id) => id !== sessionId),
        });
        if (handover)
            writeBotHandovers(
                database,
                botHandovers(database).filter((entry) => entry.sessionId !== sessionId),
            );
        // A hand-over Caxri Bot never continued leaves a `pending` task that would otherwise hold a ledger slot and
        // reappear as a duplicate if the user hands the Session over again.
        const task = handover?.taskId ? database.botTasks.get(handover.taskId) : undefined;
        if (task?.status === 'pending')
            database.botTasks.update(task.id, { status: 'dropped' }, this.now());
        this.refreshTargets();
        if (reason === 'human_input') {
            this.inputTakeBacks = [
                ...this.inputTakeBacks,
                { id: randomUUID(), sessionId, at: this.now() },
            ].slice(-MAX_BOT_INPUT_TAKE_BACKS);
        }
        this.options.logger?.write('info', logEventCatalog.caxriBot.sessionTakenBack, {
            fields: {
                sessionId,
                reason,
                source: handover?.source ?? 'created',
                isContinued: Boolean(handover?.firstDelegationId),
                ageMs: handover ? Math.max(0, this.now() - handover.createdAt) : null,
            },
        });
        this.options.sendFullStateChange();
        return { sessionId, outcome: 'taken_back' };
    }

    /**
     * Typing into a handed-over Agent, or sending its Chat a message, takes the Session back: the user is working in it
     * again, so Caxri Bot must not take the conversation over afterwards. Runs on every keystroke, so it answers from
     * memory first.
     */
    observeInput(terminalId: string): void {
        const sessionId = this.targets.get(terminalId);
        if (sessionId) this.takeBack(sessionId, 'human_input');
    }

    /**
     * Tells Caxri Bot that a handed-over Agent finished the turn it was in when the user handed it over.
     */
    onLifecycleApplied(signal: { terminalId: string }): void {
        const handover = this.awaitingReady.get(signal.terminalId);
        if (!handover) return;
        const { database } = this.options;
        if (
            isHandoverTargetBusy(
                database.getSession(handover.sessionId),
                database.getTerminal(signal.terminalId),
            )
        )
            return;
        this.awaitingReady.delete(signal.terminalId);
        const current = botHandovers(database).find((entry) => entry.id === handover.id);
        if (current && !current.firstDelegationId)
            this.options.notify({
                event: 'ready',
                handoverId: current.id,
                sessionId: current.sessionId,
            });
    }

    /**
     * Forgets each hand-over Caxri Bot has not continued whose ledger task Clear Caxri Bot Data deleted, so no relaunch
     * announces, and no continuation picks up, work the user cleared without its note. The Session stays the Caxri
     * Bot's, as any Session does after its task is deleted. Returns how many went.
     */
    forgetClearedTasks(): number {
        const { database } = this.options;
        const handovers = botHandovers(database);
        const kept = handovers.filter(
            (handover) =>
                handover.firstDelegationId !== undefined ||
                handover.taskId === undefined ||
                database.botTasks.get(handover.taskId) !== undefined,
        );
        if (kept.length === handovers.length) return 0;
        writeBotHandovers(database, kept);
        this.refreshTargets();
        return handovers.length - kept.length;
    }

    /**
     * Queues every hand-over Caxri Bot could continue but has not, for a Caxri Bot about to launch that lost the
     * in-memory notices with its previous process or a Server restart. Ownership-only hand-overs were announced once
     * and leave nothing to continue, and a hand-over still awaiting its `ready` notice gets that one instead.
     */
    requeue(): void {
        for (const handover of botHandovers(this.options.database))
            if (
                handover.target &&
                !handover.firstDelegationId &&
                !this.awaitingReady.has(handover.target.terminalId)
            )
                this.announce(handover);
    }
}
