import type {
    Principal,
    ProjectQuery,
    ProjectQueryResult,
    ProjectRecord,
    SessionQuery,
    SessionQueryResult,
    SessionRecord,
    TerminalQuery,
    TerminalQueryResult,
    TerminalRecord,
} from '@caxri/protocol';
import { CaxriError, isTopLevelProject } from '@caxri/protocol';

export interface RecordQuerySource {
    currentProjectId(): string | undefined;
    currentSessionId(): string | undefined;
    projects(): readonly ProjectRecord[];
    sessions(): readonly SessionRecord[];
    terminals(): readonly TerminalRecord[];
}

interface SelectableRecord {
    id: string;
    projectId?: string;
}

type ScopedPrincipal = Extract<
    Principal,
    { kind: 'agent' | 'delegation-client' | 'extension' | 'paired-device' }
>;

function isScopedPrincipal(principal: Principal): principal is ScopedPrincipal {
    return ['agent', 'delegation-client', 'extension', 'paired-device'].includes(principal.kind);
}

function scopeFor(principal: Principal): ReadonlySet<string> | undefined {
    return isScopedPrincipal(principal) ? new Set(principal.projectIds) : undefined;
}

/**
 * An Agent may start Sessions in any Project the user added (`authorizeDelegationSession`), so it lists every top-level
 * Project and its Sessions beside its own, to find the target and the Sessions it created. Paths stay out of its view.
 * Terminals keep the narrower scope: a Session's receipt names the Terminal an Agent's own task runs in.
 */
function catalogScopeFor(
    principal: Principal,
    projects: readonly ProjectRecord[],
): ReadonlySet<string> | undefined {
    const scope = scopeFor(principal);
    if (!scope || principal.kind !== 'agent') return scope;
    return new Set([...scope, ...projects.filter(isTopLevelProject).map(({ id }) => id)]);
}

/**
 * A paired device lists only the Projects the PrimarySidebar presents at its top level. Auto-registered worktree
 * Projects can never own a Session, so on the mobile Project filter and pickers they were entries the user never added
 * that always filtered to an empty list. Other principals keep the full list; the CLI marks worktree Projects with
 * their `ownerProjectId`.
 */
function listedProjects(
    projects: readonly ProjectRecord[],
    principal: Principal,
): readonly ProjectRecord[] {
    return principal.kind === 'paired-device' ? projects.filter(isTopLevelProject) : projects;
}

function select<T extends SelectableRecord>(
    records: readonly T[],
    selector: string,
    kind: string,
    title: (record: T) => string,
): T {
    const byId = records.find((record) => record.id === selector);
    if (byId) return byId;
    const matches = records.filter((record) => title(record) === selector);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1)
        throw new CaxriError('CONFLICT', `${kind} selector is ambiguous`, {
            candidates: matches.slice(0, 32).map((record) => ({
                id: record.id,
                displayTitle: title(record),
                ...(record.projectId && { projectId: record.projectId }),
            })),
        });
    throw new CaxriError('NOT_FOUND', `${kind} selector did not match`);
}

function selectCurrent<T extends { id: string }>(
    records: readonly T[],
    currentId: string | undefined,
    kind: string,
): T {
    if (!currentId) throw new CaxriError('NOT_FOUND', `No current ${kind} is available`);
    const record = records.find(({ id }) => id === currentId);
    if (!record) throw new CaxriError('NOT_FOUND', `Current ${kind} is unavailable`);
    return record;
}

function principalView(principal: Principal): Principal['kind'] {
    return principal.kind;
}

/**
 * Builds path-safe, principal-scoped business records before they cross the Server boundary.
 */
export class RecordQueryService {
    constructor(
        private readonly source: RecordQuerySource,
        private readonly homePath: string,
    ) {}

    /**
     * Human CLI output may identify a Project root without disclosing a path outside the user's HOME. The opaque
     * Project ID still lets callers correlate `list`, `show`, and `current`.
     */
    private projectRootIdentity(path: string, projectId: string): string {
        if (path === this.homePath) return '$HOME';
        if (path.startsWith(`${this.homePath}/`))
            return `$HOME/${path.slice(this.homePath.length + 1)}`;
        return `$PROJECT/${projectId}`;
    }

    project(query: ProjectQuery, principal: Principal): ProjectQueryResult {
        const scope = catalogScopeFor(principal, this.source.projects());
        const visible = this.source.projects().filter(({ id }) => !scope || scope.has(id));
        if (scope && query.mode === 'current')
            throw new CaxriError(
                'FORBIDDEN',
                'Agent current Project requires an endpoint-bound context',
            );
        const selected =
            query.mode === 'list'
                ? listedProjects(visible, principal)
                : query.mode === 'show'
                  ? [select(visible, query.selector, 'Project', ({ displayTitle }) => displayTitle)]
                  : [selectCurrent(visible, this.source.currentProjectId(), 'Project')];
        if (scope)
            return {
                view: principalView(principal) as ScopedPrincipal['kind'],
                projects: selected.map(({ id, displayTitle }) => ({ id, displayTitle })),
            };
        return {
            view: principalView(principal) as 'desktop' | 'human-cli',
            projects: selected.map(({ id, displayTitle, ownerProjectId, rootPath }) => ({
                id,
                displayTitle,
                rootPath: this.projectRootIdentity(rootPath, id),
                // Omitted rather than set to null for a top-level Project, so plain output stays two columns wide.
                ...(ownerProjectId !== undefined && { ownerProjectId }),
            })),
        };
    }

    session(query: SessionQuery, principal: Principal): SessionQueryResult {
        const scope = catalogScopeFor(principal, this.source.projects());
        const visible = this.source
            .sessions()
            .filter(
                ({ projectId }) =>
                    (!scope || scope.has(projectId)) &&
                    (!('projectId' in query) || !query.projectId || query.projectId === projectId),
            );
        if (scope && query.mode === 'current')
            throw new CaxriError(
                'FORBIDDEN',
                'Agent current Session requires an endpoint-bound context',
            );
        const selected =
            query.mode === 'list'
                ? visible
                : query.mode === 'show'
                  ? [select(visible, query.selector, 'Session', ({ displayTitle }) => displayTitle)]
                  : [selectCurrent(visible, this.source.currentSessionId(), 'Session')];
        return {
            view: principalView(principal),
            sessions: selected.map(
                ({
                    id,
                    projectId,
                    displayTitle,
                    archivedAt,
                    lastOpenedAt,
                    createdAt,
                    lastSessionActivityAt,
                    lastActivityState,
                    primaryAgentTerminalId,
                    attentionEpoch,
                    hasUnread,
                }) => ({
                    id,
                    projectId,
                    displayTitle,
                    ...(archivedAt !== undefined && { archivedAt }),
                    lastOpenedAt,
                    createdAt,
                    lastSessionActivityAt,
                    lastActivityState,
                    ...(primaryAgentTerminalId !== undefined && { primaryAgentTerminalId }),
                    attentionEpoch,
                    hasUnread,
                }),
            ),
        };
    }

    terminal(query: TerminalQuery, principal: Principal): TerminalQueryResult {
        const scope = scopeFor(principal);
        const visibleSessionIds = new Set<string>();
        for (const { id, projectId } of this.source.sessions())
            if (!scope || scope.has(projectId)) visibleSessionIds.add(id);
        const visible = this.source
            .terminals()
            .filter(
                ({ sessionId }) =>
                    visibleSessionIds.has(sessionId) &&
                    (!query.sessionId || query.sessionId === sessionId),
            );
        const selected =
            query.mode === 'list'
                ? visible
                : [select(visible, query.selector, 'Terminal', ({ title }) => title)];
        return {
            view: principalView(principal),
            terminals: selected.map(
                ({
                    id,
                    sessionId,
                    kind,
                    provider,
                    title,
                    lastProcessState,
                    failureReason,
                    surface,
                }) => ({
                    id,
                    sessionId,
                    kind,
                    ...(provider && { provider }),
                    title,
                    lastProcessState,
                    ...(failureReason && { failureReason }),
                    ...(surface && { surface }),
                }),
            ),
        };
    }
}
