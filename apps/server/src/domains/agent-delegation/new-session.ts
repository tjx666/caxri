import type {
    AgentDelegationCreate,
    AgentDelegationCreateRequest,
    AgentDelegationReceipt,
    SessionRelation,
} from '@caxri/protocol';
import { CaxriError, delegationTypeRelation, isTopLevelProject } from '@caxri/protocol';
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
import type { AgentDelegationServiceOptions, DelegationWorktree } from './service-options';

/**
 * How the caller's Session started the Session this request creates: a hand-off continues the caller's work, a consult
 * asks a question that changes no files, an independent one is the caller's own separate task, and anything else is a
 * task the caller waits on. Recorded only with a creator, so an owner or Caxri Bot caller gets none.
 */
function newSessionRelation(
    fields: Pick<AgentDelegationCreate, 'consult' | 'handoff' | 'independent' | 'type'>,
): SessionRelation {
    if (fields.type) return delegationTypeRelation(fields.type);
    if (fields.handoff) return 'handoff';
    if (fields.independent) return 'independent';
    return fields.consult ? 'consult' : 'delegated';
}

/**
 * The linked worktree the caller's Session works in, or `undefined` when it works in its Project folder.
 */
function callerWorktree(
    database: AgentDelegationServiceOptions['database'],
    callerSessionId: string | undefined,
): DelegationWorktree | undefined {
    const binding = callerSessionId
        ? database.getSessionWorkbenchBinding(callerSessionId)
        : undefined;
    if (!binding || binding.workbenchRootProjectId === binding.projectId) return undefined;
    return {
        projectId: binding.workbenchRootProjectId,
        ...(binding.rootDevice &&
            binding.rootInode && {
                identity: { device: binding.rootDevice, inode: binding.rootInode },
            }),
    };
}

/**
 * One queue per service, so two requests with the same ID run their whole admission (folder, Project, worktree,
 * Session, task) one after the other instead of interleaving across the awaits in it.
 */
const admissionQueues = new WeakMap<object, KeyedSerialQueue<string>>();

/**
 * Resolves the Session a create request runs in, then admits it. `newSession` creates the Session here, right before
 * its Agent Terminal, so the Workbench never shows it empty while the caller composes a second command. Any Agent or
 * the owner (from the CLI or a Client) may use it. An external delegation client may too, in a visible Project, and the
 * Session it creates nests under its anchor Session; it can neither add a Project nor create a worktree. A retry of the
 * same request reuses the Session its first attempt created, and a request refused before any task was recorded removes
 * the empty Session again (metadata only; the Project folder is never touched). The Session carries the caller's title
 * from the start; see `agentDelegationCreateRequestSchema`.
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
    const isExternal = kind === 'delegation-client';
    if (
        !newSessions ||
        (kind !== 'agent' && kind !== 'human-cli' && kind !== 'desktop' && !isExternal)
    )
        throw new CaxriError('FORBIDDEN', 'This caller cannot delegate into a new Session');
    const isBot = isCaxriBotCaller(database, authority);
    if (worktreeBranch && (isBot || isExternal || !newSessions.prepareWorktree))
        throw new CaxriError('FORBIDDEN', 'This caller cannot delegate into a new worktree');
    if (projectPath !== undefined && (isBot || isExternal || !newSessions.addProject))
        throw new CaxriError('FORBIDDEN', 'This caller cannot add a Project');
    /**
     * An Agent's own Session, the Chat a Client continues in another Agent (`agentChat.continueInAgent`), or an
     * external client's anchor Session: the nesting edge the sidebar and the cost roll-up follow.
     */
    const callerSessionId =
        authority.principal.kind === 'delegation-client'
            ? authority.principal.sessionId
            : (kind === 'agent' || kind === 'desktop') && authority.callerTerminalId
              ? database.getTerminal(authority.callerTerminalId)?.sessionId
              : undefined;
    /**
     * A type asks about the caller's own work, so without a Project it runs in the Project of the caller's Session,
     * which for a Session in a linked worktree is that worktree.
     */
    const isRunsInCallerProject =
        !fields.projectId && projectPath === undefined && Boolean(fields.type);
    const ownProjectId =
        fields.projectId ??
        (isRunsInCallerProject && callerSessionId
            ? database.getSession(callerSessionId)?.projectId
            : undefined);
    if (projectPath === undefined && !ownProjectId)
        throw new CaxriError(
            'VALIDATION',
            'Name a Project: this caller has no Session whose Project the task could run in',
        );
    /**
     * An external client reaches only a Project the user can still see, checked before the Session exists so a refusal
     * leaves nothing to discard. `authorizeDelegationSession` repeats it for the Session this request creates.
     */
    if (isExternal) {
        const target = database
            .listVisibleProjects()
            .find((candidate) => candidate.id === ownProjectId);
        if (!target || !isTopLevelProject(target))
            throw new CaxriError(
                'FORBIDDEN',
                'An external client may delegate only into a visible Project',
            );
    }
    /**
     * A forced Chat the named provider cannot satisfy is refused before the Project, the worktree and the Session
     * exist. A preset's provider is only known at admission, which refuses it there and discards the Session.
     */
    if (fields.surface === 'chat' && fields.provider)
        assertChatChildAvailable(options, fields.provider);
    /**
     * Checked before the Project and the worktree so a refused title leaves nothing behind. Only an Agent is held to
     * it: the owner's own title, from a Client or the CLI, stands as typed.
     */
    if (kind === 'agent' && !isBot && callerSessionId && title)
        assertAgentTitleLanguage(title, database.getSession(callerSessionId)?.title);
    let projectId = ownProjectId;
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
     * The worktree comes first: when it is refused, no Session was created and none needs removing. A type that runs in
     * the caller's own Project follows the caller into its linked worktree, so a review reads the changes the caller is
     * making rather than the Project folder's checkout.
     */
    const worktree = worktreeBranch
        ? await newSessions.prepareWorktree!(projectId!, worktreeBranch)
        : callerWorktree(database, isRunsInCallerProject ? callerSessionId : undefined);
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
