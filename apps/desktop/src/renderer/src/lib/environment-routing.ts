import type { BootstrapState } from '@caxri/protocol';

/**
 * Which Server owns each Project, Session, and Terminal the Workbench lists. Ids are UUIDs, unique across Servers, so
 * one index answers for every connected SSH Host; an id it does not know belongs to this Mac's Server. See
 * docs/adr/0022-multi-environment-window.md.
 */
const owners = {
    projects: new Map<string, string>(),
    sessions: new Map<string, string>(),
    terminals: new Map<string, string>(),
};

/**
 * Records of an SSH Host that disconnected, kept until a snapshot read settles them: the Workbench keeps mounted
 * Terminal panels, editor tabs, and in-flight Session operations for a moment after the Host is forgotten, and an id
 * the index no longer knows would otherwise read as this Mac's, sending their requests (some without any id, hence
 * acting on the wrong machine's files) to the local Server. A request naming one still routes to the Host's id, where
 * Main refuses it as `UNAVAILABLE` ("The SSH Host is not connected").
 */
const forgotten = new Map<string, string>();

/**
 * In-flight requests sent to an SSH Host, so `requests.cancel` reaches the Server running the request it cancels.
 */
const requestOwners = new Map<string, string>();

type OwnerKind = keyof typeof owners;

/**
 * Records a reply indexed since a snapshot read started, which that snapshot cannot list yet. Each carries the
 * generation it was indexed at, so a snapshot read before it keeps it and one read after it takes over.
 */
const replyRecords = new Map<
    string,
    { environmentId: string; generation: number; kind: OwnerKind }
>();
const routing = { generation: 0 };

/**
 * The index's current generation: read it before sending `app.bootstrap` and pass it to `indexEnvironmentSnapshot`.
 */
export function routingGeneration(): number {
    return routing.generation;
}

function forget(map: Map<string, string>, environmentId: string): void {
    for (const [id, owner] of map) if (owner === environmentId) map.delete(id);
}

/**
 * Replaces everything indexed for one SSH Host with the records of its latest snapshot, read at `readAt` (see
 * `routingGeneration`). Records a reply indexed after the read started survive: the snapshot predates them.
 */
export function indexEnvironmentSnapshot(
    environmentId: string,
    state: Pick<BootstrapState, 'archivedTerminals' | 'projects' | 'sessions' | 'terminals'>,
    readAt: number,
): void {
    for (const map of Object.values(owners)) forget(map, environmentId);
    for (const [id, owner] of forgotten) if (owner === environmentId) forgotten.delete(id);
    for (const [id, record] of replyRecords) {
        if (record.environmentId !== environmentId) continue;
        if (record.generation <= readAt) replyRecords.delete(id);
        else owners[record.kind].set(id, environmentId);
    }
    for (const project of state.projects) owners.projects.set(project.id, environmentId);
    for (const session of state.sessions) owners.sessions.set(session.id, environmentId);
    for (const terminal of state.terminals) owners.terminals.set(terminal.id, environmentId);
    for (const terminal of state.archivedTerminals)
        owners.terminals.set(terminal.id, environmentId);
}

function indexRecord(environmentId: string, value: unknown): void {
    if (typeof value !== 'object' || value === null) return;
    const id: unknown = Reflect.get(value, 'id');
    if (typeof id !== 'string') return;
    const kind: OwnerKind | undefined =
        typeof Reflect.get(value, 'rootPath') === 'string'
            ? 'projects'
            : typeof Reflect.get(value, 'projectId') === 'string'
              ? 'sessions'
              : typeof Reflect.get(value, 'sessionId') === 'string'
                ? 'terminals'
                : undefined;
    if (kind === undefined) return;
    owners[kind].set(id, environmentId);
    replyRecords.set(id, { environmentId, generation: routing.generation, kind });
}

/**
 * Indexes the Project, Session, or Terminal records an SSH Host's reply carries (`project.create` returns a Project,
 * `session.create` a Session and its Terminal), so a follow-up request about a record created a moment ago reaches that
 * Host before the next snapshot lists it. A record is recognized by the field only its kind has: a Project's
 * `rootPath`, a Session's `projectId`, a Terminal's `sessionId`.
 */
export function indexReplyRecords(environmentId: string, reply: unknown): void {
    if (typeof reply !== 'object' || reply === null) return;
    routing.generation += 1;
    indexRecord(environmentId, reply);
    for (const value of Object.values(reply)) indexRecord(environmentId, value);
}

/**
 * Drops one SSH Host's records once it is disconnected.
 */
export function forgetEnvironment(environmentId: string): void {
    for (const [id, record] of replyRecords)
        if (record.environmentId === environmentId) replyRecords.delete(id);
    for (const map of Object.values(owners))
        for (const [id, owner] of map)
            if (owner === environmentId) {
                map.delete(id);
                forgotten.set(id, environmentId);
            }
}

/**
 * The ids `forgetEnvironment` left behind so far, for `settleForgottenRecords`.
 */
export function forgottenRecordIds(): string[] {
    return forgotten.keys().toArray();
}

/**
 * Releases forgotten ids once a composed snapshot without them has been handed to the UI.
 */
export function settleForgottenRecords(ids: readonly string[]): void {
    for (const id of ids) forgotten.delete(id);
}

function ownerOf(kind: OwnerKind, id: string): string | undefined {
    return owners[kind].get(id) ?? forgotten.get(id);
}

/**
 * The SSH Host owning a Session, or `undefined` for this Mac.
 */
export function environmentOfSession(sessionId: string | undefined): string | undefined {
    return sessionId === undefined ? undefined : owners.sessions.get(sessionId);
}

/**
 * The SSH Host owning a Project, or `undefined` for this Mac.
 */
export function environmentOfProject(projectId: string | undefined): string | undefined {
    return projectId === undefined ? undefined : owners.projects.get(projectId);
}

export function environmentOfTerminal(terminalId: string | undefined): string | undefined {
    return terminalId === undefined ? undefined : owners.terminals.get(terminalId);
}

/**
 * Splits a batch of Session ids by owning machine, in first-seen order, so a bulk request reaches every Server instead
 * of only the first id's: the router reads a batch's first id alone. `undefined` is this Mac.
 */
export function sessionsByEnvironment(
    sessionIds: readonly string[],
): Array<[environmentId: string | undefined, sessionIds: string[]]> {
    const groups = new Map<string | undefined, string[]>();
    for (const sessionId of sessionIds) {
        const environmentId = ownerOf('sessions', sessionId);
        const group = groups.get(environmentId);
        if (group) group.push(sessionId);
        else groups.set(environmentId, [sessionId]);
    }
    return [...groups];
}

/**
 * A request's parameters as the router reads them: only a few id-valued keys matter, and each is checked for its type.
 */
type RequestParameters = Readonly<Record<string, unknown>>;

function stringField(parameters: RequestParameters, key: string): string | undefined {
    const value = parameters[key];
    return typeof value === 'string' ? value : undefined;
}

function firstOf(parameters: RequestParameters, key: string): string | undefined {
    const value = parameters[key];
    return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined;
}

/**
 * Param keys naming a Session, Terminal, or Project, in the order they decide the target. A request about a Session is
 * that Session's Server's, even when it also names a Project.
 */
const SESSION_KEYS = ['sessionId', 'sourceSessionId', 'viewingSessionId'] as const;
const TERMINAL_KEYS = ['terminalId', 'callerTerminalId'] as const;
const PROJECT_KEYS = ['projectId', 'workbenchRootProjectId', 'ownerProjectId'] as const;

/**
 * The SSH Host a request is about, read from the Session, Terminal, or Project it names, or `undefined` to send it to
 * this Mac's Server. A request naming none of them (settings, Desktop features, a new Project without a chosen machine)
 * is this Mac's.
 */
export function resolveRequestEnvironment(method: string, parameters: unknown): string | undefined {
    if (typeof parameters !== 'object' || parameters === null) return undefined;
    return resolveParameters(method, parameters as RequestParameters);
}

function resolveParameters(method: string, parameters: RequestParameters): string | undefined {
    if (method === 'requests.cancel') {
        const cancelled = stringField(parameters, 'requestId');
        return cancelled === undefined ? undefined : requestOwners.get(cancelled);
    }
    for (const key of SESSION_KEYS) {
        const id = stringField(parameters, key);
        if (id !== undefined) return ownerOf('sessions', id);
    }
    for (const key of TERMINAL_KEYS) {
        const id = stringField(parameters, key);
        if (id !== undefined) return ownerOf('terminals', id);
    }
    for (const key of PROJECT_KEYS) {
        const id = stringField(parameters, key);
        if (id !== undefined) return ownerOf('projects', id);
    }
    const sessionId = firstOf(parameters, 'sessionIds');
    if (sessionId !== undefined) return ownerOf('sessions', sessionId);
    const terminalId = firstOf(parameters, 'terminalIds');
    if (terminalId !== undefined) return ownerOf('terminals', terminalId);
    const projectId = firstOf(parameters, 'projectIds');
    if (projectId !== undefined) return ownerOf('projects', projectId);
    return undefined;
}

/**
 * Remembers which SSH Host runs a request until it settles, for `requests.cancel`.
 */
export function trackRemoteRequest(requestId: string, environmentId: string): () => void {
    requestOwners.set(requestId, environmentId);
    return () => {
        requestOwners.delete(requestId);
    };
}
