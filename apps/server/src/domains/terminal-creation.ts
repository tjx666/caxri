import type { TerminalKind, TerminalRecord } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { AgentCoordinator } from './agents';
import type { ConfigService } from './config';
import type { CaxriDatabase } from './db';
import type { TerminalManager } from './terminal';
import { terminalDirectoryIdentity } from './terminal';
import { resolveTerminalWorkingDirectory } from './terminal-working-directory';

interface TerminalCreationOptions {
    configuration: Pick<ConfigService, 'getSettings'>;
    coordinator: Pick<AgentCoordinator, 'prepareTerminalStart'>;
    database: CaxriDatabase;
    terminals: Pick<TerminalManager, 'launches' | 'start'>;
}

/**
 * Resolves where a new Terminal starts and launches its PTY.
 */
export function createTerminalCreation(options: TerminalCreationOptions) {
    const { configuration, coordinator, database, terminals } = options;
    const terminalWorkingDirectory = (directory: {
        authorizedRoots: readonly string[];
        defaultRoot: string;
        requestedCwd?: string;
    }) =>
        resolveTerminalWorkingDirectory({
            ...directory,
            configured:
                configuration.getSettings().value['terminal.defaultWorkingDirectory'] ?? undefined,
        });
    /**
     * `mainAuthorizedCwd` is a folder Desktop Main vouched for through a Main-only operation (an external document's
     * folder); Renderer-supplied `requestedCwd` alone must stay inside the Session's roots.
     */
    async function newTerminalWorkingDirectory(
        sessionId: string,
        requestedCwd?: string,
        mainAuthorizedCwd?: string,
    ) {
        const session = database.getSession(sessionId);
        if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
        const ownerProject = database.getProject(session.projectId);
        if (!ownerProject) throw new CaxriError('NOT_FOUND', 'Project not found');
        return terminalWorkingDirectory({
            authorizedRoots: [
                ownerProject.rootPath,
                session.rootPath,
                ...(mainAuthorizedCwd ? [mainAuthorizedCwd] : []),
            ],
            defaultRoot: session.rootPath,
            requestedCwd,
        });
    }
    async function createAndStartTerminal(
        sessionId: string,
        kind: TerminalKind,
        requestedCwd?: string,
        beforeStart?: (terminal: TerminalRecord) => void,
        mainAuthorizedCwd?: string,
    ): Promise<TerminalRecord> {
        // The record does not exist until the working directory resolves; a detach starting meanwhile must still wait.
        const prepared = terminals.launches.begin(sessionId);
        try {
            const cwd = await newTerminalWorkingDirectory(
                sessionId,
                requestedCwd,
                mainAuthorizedCwd,
            );
            const expectedWorkingDirectory = await terminalDirectoryIdentity(cwd);
            const terminal = database.createTerminal(sessionId, kind, cwd);
            beforeStart?.(terminal);
            coordinator.prepareTerminalStart(terminal.id);
            try {
                return await terminals.start(terminal, { expectedWorkingDirectory });
            } catch {
                return database.getTerminal(terminal.id)!;
            }
        } finally {
            prepared();
        }
    }
    return { createAndStartTerminal, newTerminalWorkingDirectory, terminalWorkingDirectory };
}
