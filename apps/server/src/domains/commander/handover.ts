import { randomUUID } from 'node:crypto';
import { sep } from 'node:path';

import type {
    CommanderConversation,
    CommanderConversationReference,
    CommanderHandover,
    CommanderHandoverOutcome,
    CommanderHandoverOwnershipReason,
    CommanderHandoverRejection,
    CommanderHandoverRequest,
    CommanderHandoverResult,
    ProjectRecord,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import {
    CaxriError,
    delegationProviderSchema,
    isTopLevelProject,
    logEventCatalog,
    MAX_COMMANDER_CONVERSATIONS,
    MAX_COMMANDER_TASKS,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { CaxriDatabase } from '../db';
import {
    commanderHandovers,
    consumeCommanderHandover,
    pendingCommanderHandover,
    writeCommanderHandovers,
} from './handover-records';
import type { CommanderHandoverNoticeEvent } from './notice-text';

/**
 * Mirrors `createCommanderSession`'s cap, so a hand-over can never grow the ownership record past what the Commander
 * could have created itself.
 */
const MAX_COMMANDER_SESSIONS = 1_000;

/**
 * One external conversation as the provider discovery reports it, before it is matched to a Project.
 */
export type DiscoveredConversation = Omit<CommanderConversation, 'projectId'>;

export interface CommanderHandoverServiceOptions {
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
     * Queues the content-free line that tells the Commander about a hand-over; see `CommanderCompletionNotifier`.
     */
    notify(entry: {
        event: CommanderHandoverNoticeEvent;
        handoverId: string;
        sessionId: string;
    }): void;
    /**
     * Resolves a folder to the root of the Project that should own it: the repository root of a worktree, the folder
     * itself otherwise. Rejects a folder that no longer exists.
     */
    resolveProjectRoot(path: string): Promise<string>;
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
 * Why a Session's Agent conversation cannot be continued by the Commander, if it cannot.
 */
function ownershipReason(
    terminal: TerminalRecord | undefined,
): CommanderHandoverOwnershipReason | undefined {
    if (!terminal?.provider) return 'agent_missing';
    if (terminal.surface === 'chat') return 'chat_surface';
    if (!delegationProviderSchema.safeParse(terminal.provider).success)
        return 'provider_unsupported';
    if (!terminal.agentSessionId) return 'provider_session_missing';
    return undefined;
}

/**
 * True while the Agent is in a turn or waiting on the user. A continuation then would cut the turn off, so the
 * Commander waits for the `ready` notice instead.
 */
function isHandoverTargetBusy(
    session: SessionRecord | undefined,
    terminal: TerminalRecord | undefined,
): boolean {
    return (
        terminal?.lastAgentProcessState === 'running' &&
        (session?.lastActivityState === 'running' || session?.lastActivityState === 'waiting')
    );
}

/**
 * The deepest visible top-level Project whose root contains `path`.
 */
function containingProject(
    projects: readonly ProjectRecord[],
    path: string,
): ProjectRecord | undefined {
    return projects
        .filter(
            (project) =>
                isTopLevelProject(project) &&
                (path === project.rootPath || path.startsWith(`${project.rootPath}${sep}`)),
        )
        .toSorted((left, right) => right.rootPath.length - left.rootPath.length)[0];
}

function conversationKey(conversation: CommanderConversationReference): string {
    return `${conversation.provider}:${conversation.providerSessionId}`;
}

/**
 * The user's side of Commander ownership: handing Sessions (or Agent conversations started outside Caxri) to the
 * Commander, taking them back, and noticing when the user takes one back by typing into its Agent. The Commander can
 * never call these; see `commanderHandoverMethods`.
 */
export class CommanderHandoverService {
    private readonly now: () => number;
    /**
     * Agent Terminals of current hand-overs, so the per-keystroke input hook answers in constant time.
     */
    private targets = new Map<string, string>();
    /**
     * Hand-overs whose Agent was mid-turn when handed over, by Agent Terminal: the Commander gets `ready` once it
     * finishes. In memory only; `requeue` rebuilds the notices for a relaunched Commander.
     */
    private readonly awaitingReady = new Map<string, CommanderHandover>();

    constructor(private readonly options: CommanderHandoverServiceOptions) {
        this.now = options.now ?? Date.now;
        this.refreshTargets();
    }

    private refreshTargets(): void {
        this.targets = new Map(
            commanderHandovers(this.options.database).flatMap((handover) =>
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

    private announce(handover: CommanderHandover): void {
        const { database } = this.options;
        const terminal = handover.target && database.getTerminal(handover.target.terminalId);
        const event: CommanderHandoverNoticeEvent = !handover.target
            ? 'ownership_only'
            : isHandoverTargetBusy(database.getSession(handover.sessionId), terminal)
              ? 'busy'
              : 'ready';
        if (event === 'busy' && handover.target)
            this.awaitingReady.set(handover.target.terminalId, handover);
        this.options.notify({ event, handoverId: handover.id, sessionId: handover.sessionId });
    }

    private async importConversations(
        conversations: readonly CommanderConversationReference[],
        batch: {
            reject(
                reason: CommanderHandoverRejection,
                entry: { conversation: CommanderConversationReference },
            ): void;
            hasCapacity(entry: { conversation: CommanderConversationReference }): boolean;
            accept(
                session: SessionRecord,
                source: 'conversation',
                terminal: TerminalRecord,
                conversation: CommanderConversationReference,
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

    /**
     * Creates the Session that holds an external conversation: a parked Agent Terminal bound to the conversation, so
     * opening the Session or the Commander's first task resumes it. Selection stays where the user is.
     */
    private async importConversation(
        conversation: DiscoveredConversation,
    ): Promise<{ session: SessionRecord; terminal: TerminalRecord } | undefined> {
        const { database } = this.options;
        let project = containingProject(database.listVisibleProjects(), conversation.cwd);
        if (!project) {
            let rootPath: string;
            try {
                rootPath = await this.options.resolveProjectRoot(conversation.cwd);
            } catch {
                return undefined;
            }
            project = database.createProject(rootPath);
            if (!isTopLevelProject(project)) return undefined;
        }
        const { session } = database.createSession(project.id, null, undefined, {
            selection: 'preserve',
        });
        const title = conversation.title?.trim().slice(0, 200);
        if (title) database.renameSession(session.id, title);
        const terminal = database.createTerminal(
            session.id,
            conversation.provider,
            conversation.cwd,
        );
        database.rebindAgentSession(
            terminal.id,
            conversation.provider,
            conversation.providerSessionId,
        );
        database.updateTerminalState(terminal.id, 'detached');
        database.updateAgentProcessState(terminal.id, 'detached');
        return {
            session: database.getSession(session.id)!,
            terminal: database.getTerminal(terminal.id)!,
        };
    }

    private finish(
        outcomes: CommanderHandoverOutcome[],
        added: readonly CommanderHandover[],
    ): CommanderHandoverResult {
        const rejected = outcomes.flatMap((outcome) =>
            outcome.outcome === 'rejected' ? [outcome.reason] : [],
        );
        this.options.logger?.write('info', logEventCatalog.agentCommander.sessionsHandedOver, {
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
            this.options.logger?.write('info', logEventCatalog.agentCommander.taskRecorded, {
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
    async conversations(): Promise<{ conversations: CommanderConversation[] }> {
        const discovered =
            (await this.options.discoverConversations?.(this.boundProviderSessionIds())) ?? [];
        const projects = this.options.database.listVisibleProjects();
        return {
            conversations: discovered.slice(0, MAX_COMMANDER_CONVERSATIONS).map((conversation) => ({
                ...conversation,
                projectId: containingProject(projects, conversation.cwd)?.id ?? null,
            })),
        };
    }

    managedSessions(): { sessionIds: string[] } {
        return { sessionIds: [...(this.options.database.agentCommanderRows()?.sessionIds ?? [])] };
    }

    /**
     * Hands every entry over on its own: a refused entry never blocks the rest. Conversations are imported into a new
     * Session first, adding their folder as a Project when no visible Project contains it.
     */
    async handOver(request: CommanderHandoverRequest): Promise<CommanderHandoverResult> {
        const { database } = this.options;
        const sessionIds = request.sessionIds ?? [];
        const conversations = request.conversations ?? [];
        const outcomes: CommanderHandoverOutcome[] = [];
        const reject = (
            reason: CommanderHandoverRejection,
            entry: { sessionId?: string; conversation?: CommanderConversationReference },
        ) => outcomes.push({ outcome: 'rejected', reason, ...entry });
        const rows = database.agentCommanderRows();
        if (!rows) {
            for (const sessionId of sessionIds) reject('commander_unavailable', { sessionId });
            for (const conversation of conversations)
                reject('commander_unavailable', { conversation });
            return this.finish(outcomes, []);
        }
        const owned = new Set(rows.sessionIds);
        const added: CommanderHandover[] = [];
        let openTasks = database.commanderTasks.countOpen();
        const hasCapacity = (entry: {
            sessionId?: string;
            conversation?: CommanderConversationReference;
        }) => {
            if (owned.size >= MAX_COMMANDER_SESSIONS) reject('ownership_capacity', entry);
            else if (openTasks >= MAX_COMMANDER_TASKS) reject('task_capacity', entry);
            else return true;
            return false;
        };
        const accept = (
            session: SessionRecord,
            source: CommanderHandover['source'],
            terminal: TerminalRecord | undefined,
            conversation?: CommanderConversationReference,
        ) => {
            const reason = ownershipReason(terminal);
            const task = database.commanderTasks.insert(
                {
                    title: session.displayTitle.trim().slice(0, 200) || 'Handed-over Session',
                    status: 'pending',
                    projectId: session.projectId,
                    sessionId: session.id,
                    ...(request.note && { note: request.note }),
                },
                this.now(),
            );
            openTasks += 1;
            const handover: CommanderHandover = {
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
            owned.add(session.id);
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
        const visibleProjects = new Set(
            database
                .listVisibleProjects()
                .filter((project) => isTopLevelProject(project))
                .map((project) => project.id),
        );
        const seen = new Set<string>();
        for (const sessionId of sessionIds) {
            const session = database.getSession(sessionId);
            if (seen.has(sessionId)) reject('duplicate', { sessionId });
            else if (!session) reject('session_missing', { sessionId });
            else if (session.archivedAt !== undefined) reject('session_archived', { sessionId });
            else if (sessionId === rows.sessionId) reject('commander_session', { sessionId });
            else if (!visibleProjects.has(session.projectId))
                reject('project_unavailable', { sessionId });
            else if (owned.has(sessionId)) reject('already_managed', { sessionId });
            else if (hasCapacity({ sessionId }))
                accept(
                    session,
                    'session',
                    primaryAgent(session, database.listTerminals(sessionId)),
                );
            seen.add(sessionId);
        }
        if (conversations.length > 0)
            await this.importConversations(conversations, { reject, hasCapacity, accept });
        if (added.length > 0) {
            const current = database.agentCommanderRows() ?? rows;
            database.setAppState('agentCommander', {
                projectId: current.projectId,
                sessionId: current.sessionId,
                ...(current.terminalId && { terminalId: current.terminalId }),
                sessionIds: [
                    ...new Set([...current.sessionIds, ...added.map((entry) => entry.sessionId)]),
                ],
            });
            writeCommanderHandovers(database, [...commanderHandovers(database), ...added]);
            this.refreshTargets();
        }
        return this.finish(outcomes, added);
    }

    /**
     * Removes a Session from the Commander's management. Its Agents keep running; tasks the Commander already started
     * there keep their receipts, but the Commander can no longer start or continue one.
     */
    takeBack(
        sessionId: string,
        reason: 'take_back' | 'human_input' = 'take_back',
    ): { sessionId: string; outcome: 'taken_back' | 'not_managed' } {
        const { database } = this.options;
        const rows = database.agentCommanderRows();
        if (!database.getSession(sessionId)) throw new CaxriError('NOT_FOUND', 'Session not found');
        if (!rows?.sessionIds.includes(sessionId)) return { sessionId, outcome: 'not_managed' };
        const handover = commanderHandovers(database).find(
            (entry) => entry.sessionId === sessionId,
        );
        database.setAppState('agentCommander', {
            projectId: rows.projectId,
            sessionId: rows.sessionId,
            ...(rows.terminalId && { terminalId: rows.terminalId }),
            sessionIds: rows.sessionIds.filter((id) => id !== sessionId),
        });
        if (handover)
            writeCommanderHandovers(
                database,
                commanderHandovers(database).filter((entry) => entry.sessionId !== sessionId),
            );
        this.refreshTargets();
        this.options.logger?.write('info', logEventCatalog.agentCommander.sessionTakenBack, {
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
     * Typing into a handed-over Agent takes the Session back: the user is working in it again, so the Commander must
     * not take the conversation over afterwards. Runs on every keystroke, so it answers from memory first.
     */
    observeInput(terminalId: string): void {
        const sessionId = this.targets.get(terminalId);
        if (sessionId) this.takeBack(sessionId, 'human_input');
    }

    /**
     * Tells the Commander that a handed-over Agent finished the turn it was in when the user handed it over.
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
        const current = commanderHandovers(database).find((entry) => entry.id === handover.id);
        if (current && !current.firstDelegationId)
            this.options.notify({
                event: 'ready',
                handoverId: current.id,
                sessionId: current.sessionId,
            });
    }

    /**
     * Queues every hand-over the Commander could continue but has not, for a Commander about to launch that lost the
     * in-memory notices with its previous process or a Server restart. Ownership-only hand-overs were announced once
     * and leave nothing to continue, and a hand-over still awaiting its `ready` notice gets that one instead.
     */
    requeue(): void {
        for (const handover of commanderHandovers(this.options.database))
            if (
                handover.target &&
                !handover.firstDelegationId &&
                !this.awaitingReady.has(handover.target.terminalId)
            )
                this.announce(handover);
    }
}

/**
 * The delegation service's view of hand-overs, for the Commander's `--continue-handover` task.
 */
export function commanderHandoverAccess(
    database: CaxriDatabase,
    logger?: StructuredLogger,
    now: () => number = Date.now,
) {
    return {
        target: (handoverId: string, sessionId: string) =>
            pendingCommanderHandover(database, handoverId, sessionId).target,
        isBusy: (sessionId: string, terminalId: string) =>
            isHandoverTargetBusy(database.getSession(sessionId), database.getTerminal(terminalId)),
        /**
         * Links the hand-over's task to the delegation, as `commander task update --delegation` would, so the ledger
         * never records a second task for the new root delegation.
         */
        consume: (handoverId: string, delegationId: string) => {
            const handover = consumeCommanderHandover(database, handoverId, delegationId);
            if (!handover) return;
            const task = handover.taskId ? database.commanderTasks.get(handover.taskId) : undefined;
            if (task)
                database.commanderTasks.update(
                    task.id,
                    {
                        delegationId,
                        ...(task.status === 'pending' && { status: 'dispatched' }),
                    },
                    now(),
                );
            logger?.write('info', logEventCatalog.agentCommander.handoverContinued, {
                fields: {
                    handoverId,
                    delegationId,
                    source: handover.source,
                    waitMs: Math.max(0, now() - handover.createdAt),
                },
            });
        },
    };
}
