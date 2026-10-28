import type { SessionSearchIndex } from './agents';
import { botWorkspacePath } from './bot';
import type { CaxriDatabase } from './db';
import type { DomainDependencies } from './domain-services';
import type { GitService } from './git';
import { resolveOwnerProjectRoot } from './project';
import { SessionAgentHistoryService, SessionSearchService } from './session';

/**
 * Builds the two services that read the Session search index: search with conversation import, and a Session's own
 * Agent history. Import places a conversation from a linked worktree under the Project owning its repository, and Caxri
 * Bot's workspace stays out of search because the Bot hides its own Session.
 */
export function createSessionSearchServices({
    database,
    emit,
    git,
    index,
    userDataPath,
}: {
    database: CaxriDatabase;
    emit: DomainDependencies['send'];
    git: GitService;
    index: Pick<SessionSearchIndex, 'describe' | 'inspect' | 'search'>;
    userDataPath: string;
}) {
    const sessionSearch = new SessionSearchService({
        database,
        index,
        resolveProjectRoot: resolveOwnerProjectRoot,
        onSessionImported: () =>
            emit({ event: 'state.changed', payload: { kind: 'full', reason: 'session.create' } }),
        internalRoots: [botWorkspacePath(userDataPath)],
        readTopology: (path) => git.worktreeTopology(path),
    });
    const sessionAgentHistory = new SessionAgentHistoryService({
        database,
        index,
        onTerminalCreated: () =>
            emit({ event: 'state.changed', payload: { kind: 'full', reason: 'terminal.create' } }),
    });
    return { sessionAgentHistory, sessionSearch };
}
