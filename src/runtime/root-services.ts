import { join } from 'node:path';

import type { RuntimeDeps } from './bootstrap-types';
import { ConfigurationService } from './configuration';
import { CaxriDatabase } from './db';
import { FileService } from './files';
import { GitService } from './git';
import { ProjectRootResolver } from './project-roots';
import { WorkbenchRootService } from './workbench-roots';

/** Applies durable inactive-root editor state before the journal record becomes unrecoverable. */
export async function acknowledgeFileMutation(
    database: CaxriDatabase,
    files: FileService,
    operationId: string,
): Promise<void> {
    const operation = await files.getMutationOperation(operationId);
    if (operation?.phase === 'completed' && operation.kind !== 'create' && operation.result) {
        const workbenchProjectId =
            operation.workbenchProjectId ?? database.getSession(operation.sessionId)?.projectId;
        if (workbenchProjectId)
            database.remapWorkbenchEditorState(
                workbenchProjectId,
                operation.id,
                operation.result.previousPath,
                operation.result.path,
            );
    }
    await files.acknowledgeMutationOperation(operationId);
}

/** Builds the persistence and root-authorized services that Files, Git, and Workbench share. */
export async function createRootServices({ logger, send, userDataPath }: RuntimeDeps) {
    const database = new CaxriDatabase(join(userDataPath, 'caxri.db'), {
        onSessionStateRepair: ({ reason, sessionId, stateVersion }) =>
            logger.write('warn', 'db.session_state_repaired', {
                fields: { reason, sessionId, stateVersion },
            }),
    });
    const configuration = new ConfigurationService(userDataPath, send, logger);
    await configuration.initialize();
    database.setAppState('activeThemeId', configuration.getTheme().value.id);

    const git = new GitService(new ProjectRootResolver(database), logger);
    const workbenchRoots = new WorkbenchRootService({
        behavior: () => configuration.getSettings().value['workbench.newWorktreeBehavior'],
        database,
        emit: send,
        git,
        logger,
    });
    const files = new FileService(
        database,
        send,
        logger,
        () => configuration.getSettings().value['files.maxFileBytes'],
        {
            decorateGitIgnored: (sessionId, directory, names) =>
                git.ignoredEntries(sessionId, directory, names),
            fileTreeExcludes: () => configuration.getSettings().value['files.exclude'],
            mutationJournalPath: join(userDataPath, 'file-operations.json'),
            onRootUnavailable: (sessionId) => void workbenchRoots.validateSession(sessionId),
        },
    );
    await files.initialize();
    return {
        acknowledgeFileMutation: (operationId: string) =>
            acknowledgeFileMutation(database, files, operationId),
        configuration,
        database,
        files,
        git,
        workbenchRoots,
    };
}
