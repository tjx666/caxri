import type {
    ProjectQuery,
    ProjectQueryResult,
    SessionQuery,
    SessionQueryResult,
    TerminalQuery,
    TerminalQueryResult,
} from '../../shared/ipc/business-contract';
import { CaxriError } from '../../shared/ipc/errors';
import type { Principal } from '../../shared/ipc/principal';
import type { ProjectRecord, SessionRecord, TerminalRecord } from '../../shared/types';

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

function scopeFor(principal: Principal): ReadonlySet<string> | undefined {
    return principal.kind === 'agent' || principal.kind === 'paired-device'
        ? new Set(principal.projectIds)
        : undefined;
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
                ...(record.projectId ? { projectId: record.projectId } : {}),
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

/** Builds path-safe, principal-scoped business records before they cross the Host boundary. */
export class RecordQueryService {
    constructor(
        private readonly source: RecordQuerySource,
        private readonly homePath: string,
    ) {}

    /**
     * Human CLI output may identify a Project root without disclosing a path outside the user's
     * HOME. The opaque Project ID still lets callers correlate `list`, `show`, and `current`.
     */
    private projectRootIdentity(path: string, projectId: string): string {
        if (path === this.homePath) return '$HOME';
        if (path.startsWith(`${this.homePath}/`))
            return `$HOME/${path.slice(this.homePath.length + 1)}`;
        return `$PROJECT/${projectId}`;
    }

    project(query: ProjectQuery, principal: Principal): ProjectQueryResult {
        const scope = scopeFor(principal);
        const visible = this.source.projects().filter(({ id }) => !scope || scope.has(id));
        if (query.mode === 'current' && scope)
            throw new CaxriError(
                'FORBIDDEN',
                'Agent current Project requires an endpoint-bound context',
            );
        const selected =
            query.mode === 'list'
                ? visible
                : query.mode === 'show'
                  ? [select(visible, query.selector, 'Project', ({ displayTitle }) => displayTitle)]
                  : [selectCurrent(visible, this.source.currentProjectId(), 'Project')];
        if (scope)
            return {
                view: principalView(principal) as 'agent' | 'paired-device',
                projects: selected.map(({ id, displayTitle }) => ({ id, displayTitle })),
            };
        return {
            view: principalView(principal) as 'desktop' | 'human-cli',
            projects: selected.map(({ id, displayTitle, rootPath }) => ({
                id,
                displayTitle,
                rootPath: this.projectRootIdentity(rootPath, id),
            })),
        };
    }

    session(query: SessionQuery, principal: Principal): SessionQueryResult {
        const scope = scopeFor(principal);
        const visible = this.source
            .sessions()
            .filter(
                ({ projectId }) =>
                    (!scope || scope.has(projectId)) &&
                    (!('projectId' in query) || !query.projectId || query.projectId === projectId),
            );
        if (query.mode === 'current' && scope)
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
                    lastActivityState,
                    hasUnread,
                }) => ({
                    id,
                    projectId,
                    displayTitle,
                    ...(archivedAt === undefined ? {} : { archivedAt }),
                    lastOpenedAt,
                    lastActivityState,
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
                ({ id, sessionId, kind, provider, title, lastProcessState, failureReason }) => ({
                    id,
                    sessionId,
                    kind,
                    ...(provider ? { provider } : {}),
                    title,
                    lastProcessState,
                    ...(failureReason ? { failureReason } : {}),
                }),
            ),
        };
    }
}
