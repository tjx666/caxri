import type {
    AgentDelegationCreate,
    AgentDelegationCreateRequest,
    AgentDelegationReceipt,
    SessionRelation,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { KeyedSerialQueue } from '@caxri/system';

/**
 * Server domain boundaries require the owning public root; structure tests reject cross-domain deep imports.
 */
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { assertAgentTitleLanguage } from '../agents';
import type { DelegationAuthority } from './admission';
import { isCaxriBotCaller } from './admission';
import { assertChatChildAvailable } from './chat-child';
import { logDelegationProjectAdded } from './diagnostics';
import type { AgentDelegationServiceOptions } from './service-options';

/**
 * How the caller's Session started the Session this request creates: a hand-off continues the caller's work, a consult
 * asks a question that changes no files, and anything else is a task the caller waits on. Recorded only with a creator,
 * so an owner or Caxri Bot caller gets none.
 */
function newSessionRelation(
    fields: Pick<AgentDelegationCreate, 'consult' | 'handoff'>,
): SessionRelation {
    if (fields.handoff) return 'handoff';
    return fields.consult ? 'consult' : 'delegated';
}

/**
 * One queue per service, so two requests with the same ID run their whole admission (folder, Project, worktree,
 * Session, task) one after the other instead of interleaving across the awaits in it.
 */
const admissionQueues = new WeakMap<object, KeyedSerialQueue<string>>();

/**
 * Resolves the Session a create request runs in, then admits it. `newSession` creates the Session here, right before
 * its Agent Terminal, so the Workbench never shows it empty while the caller composes a second command. Any Agent or
 * the owner (from the CLI or a Client) may use it; an external delegation identity stays bound to its one Session. A
 * retry of the same request reuses the Session its first attempt created, and a request refused before any task was
 * recorded removes the empty Session again (metadata only; the Project folder is never touched). The Session carries
 * the caller's title from the start; see `agentDelegationCreateRequestSchema`.
 *
 * A `projectPath` adds that folder as a visible Project (the authority of `project.add`) and continues with the
 * resulting Project ID, so the stored task and the Session still reference a Project by ID. Everything that can be
 * refused without a side effect is checked before the folder is added. A refusal after the add keeps the Project: it
 * may have existed already, and removing a Project the user may have since opened would lose more than keeping it.
 * `admit` receives the path so the request fingerprint covers the original request, not only the Project it resolved
 * to; a replay then reuses the recorded Project and never adds again.
 */
export function admitDelegationRequest(
    options: Pick<
        AgentDelegationServiceOptions,
        'newSessions' | 'database' | 'hasAgentChat' | 'logger'
    >,
    id: string,
    authority: DelegationAuthority,
    request: AgentDelegationCreateRequest,
    admit: (
        input: AgentDelegationCreate,
        isNewSession: boolean,
        projectPath?: string,
    ) => Promise<AgentDelegationReceipt>,
): Promise<AgentDelegationReceipt> {
    const { newSession, sessionId, projectPath, title, worktreeBranch, ...fields } = request;
    // The schema guarantees a Project ID without `newSession`; a path is only ever resolved by `admitNewSession`.
    if (!newSession)
        return admit({ ...fields, projectId: fields.projectId!, sessionId: sessionId! }, false);
    let queue = admissionQueues.get(options.database);
    if (!queue) {
        queue = new KeyedSerialQueue<string>();
        admissionQueues.set(options.database, queue);
    }
    return queue.run(id, () =>
        admitNewSession(
            options,
            id,
            authority,
            { ...fields, projectPath, title, worktreeBranch },
            admit,
        ),
    );
}

type NewSessionRequest = Omit<AgentDelegationCreateRequest, 'newSession' | 'sessionId'>;

async function admitNewSession(
    options: Pick<
        AgentDelegationServiceOptions,
        'newSessions' | 'database' | 'hasAgentChat' | 'logger'
    >,
    id: string,
    authority: DelegationAuthority,
    request: NewSessionRequest,
    admit: (
        input: AgentDelegationCreate,
        isNewSession: boolean,
        projectPath?: string,
    ) => Promise<AgentDelegationReceipt>,
): Promise<AgentDelegationReceipt> {
    const { title, worktreeBranch, projectPath, ...fields } = request;
    const { newSessions, database } = options;
    const existing = database.agentDelegations.get(id);
    if (existing)
        return admit(
            {
                ...fields,
                projectId: fields.projectId ?? existing.input.projectId,
                sessionId: existing.input.sessionId,
            },
            false,
            projectPath,
        );
    const { kind } = authority.principal;
    if (!newSessions || (kind !== 'agent' && kind !== 'human-cli' && kind !== 'desktop'))
        throw new CaxriError('FORBIDDEN', 'This caller cannot delegate into a new Session');
    const isBot = isCaxriBotCaller(database, authority);
    if (worktreeBranch && (isBot || !newSessions.prepareWorktree))
        throw new CaxriError('FORBIDDEN', 'This caller cannot delegate into a new worktree');
    if (projectPath !== undefined && (isBot || !newSessions.addProject))
        throw new CaxriError('FORBIDDEN', 'This caller cannot add a Project');
    /**
     * A forced Chat the named provider cannot satisfy is refused before the Project, the worktree and the Session
     * exist. A preset's provider is only known at admission, which refuses it there and discards the Session.
     */
    if (fields.surface === 'chat' && fields.provider)
        assertChatChildAvailable(options, fields.provider);
    /**
     * An Agent's own Session, or the Chat a Client continues in another Agent (`agentChat.continueInAgent`).
     */
    const callerSessionId =
        (kind === 'agent' || kind === 'desktop') && authority.callerTerminalId
            ? database.getTerminal(authority.callerTerminalId)?.sessionId
            : undefined;
    /**
     * Checked before the Project and the worktree so a refused title leaves nothing behind. Only an Agent is held to
     * it: the owner's own title, from a Client or the CLI, stands as typed.
     */
    if (kind === 'agent' && !isBot && callerSessionId && title)
        assertAgentTitleLanguage(title, database.getSession(callerSessionId)?.title);
    let projectId = fields.projectId;
    if (projectPath !== undefined) {
        const startedAt = Date.now();
        const added = await newSessions.addProject!(projectPath);
        projectId = added.id;
        logDelegationProjectAdded(options.logger, {
            outcome: added.outcome,
            principalKind: kind,
            durationMs: Date.now() - startedAt,
        });
    }
    /**
     * The worktree comes first: when it is refused, no Session was created and none needs removing.
     */
    const worktree = worktreeBranch
        ? await newSessions.prepareWorktree!(projectId!, worktreeBranch)
        : undefined;
    const creatorSessionId = isBot ? undefined : callerSessionId;
    const sessionId = newSessions.create(
        projectId!,
        title,
        isBot,
        creatorSessionId,
        creatorSessionId ? newSessionRelation(fields) : undefined,
        worktree,
    );
    const input = { ...fields, projectId: projectId!, sessionId };
    try {
        return await admit(input, true, projectPath);
    } catch (error) {
        const recorded = database.agentDelegations.get(id);
        if (recorded?.input.sessionId === sessionId) throw error;
        newSessions.discard(sessionId);
        /**
         * A concurrent retry of the same request created its own Session before admission recorded the task in the
         * other one, and was refused as a different request. Its Session stays empty, so it is removed and the retry
         * resolves to the recorded task like any later retry.
         */
        if (!recorded) throw error;
        return admit({ ...input, sessionId: recorded.input.sessionId }, false, projectPath);
    }
}
