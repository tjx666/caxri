import { join } from 'node:path';

import { CaxriError, errorMessage } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

/**
 * Server domain boundaries require cross-domain dependencies to enter through the owning domain root.
 */
// react-doctor-disable-next-line react-doctor/no-barrel-import
import {
    AgentTimelineService,
    AgentTranscriptWatcher,
    defaultAgentEnvironment,
    locateAgentTranscript,
    resolveAgentTranscriptLocation,
} from './agents';
import { ConfigService } from './config';
import { CaxriDatabase } from './db';
import type { DomainDependencies } from './domain-services';
import { ExternalStatusHub } from './external-status';
import { FileService } from './files';
import { GitService } from './git';
import { ProjectRootResolver } from './project-roots';
import { SessionContextService } from './session-context';
import { WatchHub } from './watch-hub';
import { WorkbenchRootService } from './workbench-roots';

/**
 * Applies durable inactive-root editor state before the journal record becomes unrecoverable.
 */
export async function acknowledgeFileMutation(
    database: CaxriDatabase,
    files: FileService,
    sessionId: string,
    operationId: string,
): Promise<void> {
    const operation = await files.getScopedMutationOperation(sessionId, operationId);
    if (!operation)
        throw new CaxriError('PATH_DENIED', 'File operation is outside the selected Project');
    if (operation.phase === 'completed' && operation.kind !== 'create' && operation.result) {
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
    await files.acknowledgeScopedMutationOperation(sessionId, operationId);
}

/**
 * Builds the persistence and root-authorized services that Files, Git, and Workbench share.
 */
export async function createRootServices({
    agentEnvironment,
    logger,
    projectSearch,
    send,
    userDataPath,
}: DomainDependencies) {
    const database = new CaxriDatabase(join(userDataPath, 'caxri.db'), {
        onSessionStateRepair: ({ reason, sessionId, stateVersion }) =>
            logger.write('warn', logEventCatalog.database.sessionStateRepaired, {
                fields: { reason, sessionId, stateVersion },
            }),
        onSessionStateUnchanged: ({
            sessionId,
            workbenchProjectId,
            unchangedWrites,
            totalWrites,
        }) =>
            logger.write('debug', logEventCatalog.database.sessionStateUnchanged, {
                fields: { sessionId, workbenchProjectId, unchangedWrites, totalWrites },
            }),
        onTransaction: ({ durationMs, outcome }) => {
            const metricOutcome = outcome === 'success' ? 'success' : 'failure';
            logger.recordMetric('persistence.latency', durationMs, {
                owner: 'persistence',
                phase: 'commit',
                outcome: metricOutcome,
            });
            if (outcome === 'contention')
                logger.recordMetric('persistence.contention', 1, {
                    owner: 'persistence',
                    phase: 'commit',
                    outcome: metricOutcome,
                });
        },
    });
    /**
     * One Server-wide watch registry: every filesystem watcher and intentional poller registers here so listener count,
     * polling degradations, and event rates stay centrally gated and observable (`DiagnosticsService`).
     */
    const watchHub = new WatchHub({ logger });
    const timeline = new AgentTimelineService(
        database,
        agentEnvironment ?? defaultAgentEnvironment(),
    );
    const transcripts = new AgentTranscriptWatcher({
        emit: send,
        onForgetTerminal: (terminalId) => timeline.forgetTerminal(terminalId),
        locationForTerminal: (terminalId) =>
            resolveAgentTranscriptLocation(database, terminalId, agentEnvironment),
        locateForTerminal: (terminalId) =>
            locateAgentTranscript(database, terminalId, agentEnvironment),
        terminalIdsForSession: (sessionId) =>
            database.listTerminals(sessionId).map((terminal) => terminal.id),
        watchHub,
    });
    const config = new ConfigService(userDataPath, send, logger, { watchHub });
    await config.initialize();
    database.setAppState('activeThemeId', config.getTheme().value.id);

    /**
     * One owner for every `gh`, `linear`, and `vc` query in the Server. Constructed before Git so Source Control, the
     * Status panel, the status bar, and the sidebar sweep all share a single pull-request projection and a single
     * per-source rate-limit circuit instead of discovering the same limit four times over.
     */
    const externalStatus = new ExternalStatusHub({ logger });
    const git = new GitService(new ProjectRootResolver(database), logger, {
        emit: send,
        externalStatus,
        watchHub,
    });
    /**
     * One incremental reader for every Agent transcript clue the product consumes. Shared so the Workbench Root picker
     * and the status bar's Linear lookup pay for a transcript's bytes once between them.
     */
    const sessionContext = new SessionContextService(database, agentEnvironment);
    const workbenchRoots = new WorkbenchRootService({
        behavior: () => config.getSettings().value['workbench.newWorktreeBehavior'],
        database,
        emit: send,
        git,
        logger,
        sessionContext: (session) => sessionContext.read(session),
    });
    const files = new FileService(
        database,
        (event) => {
            /**
             * The Git domain observes working-tree changes before the Renderer sees them, so the repository generations
             * behind `git.changed` always advance ahead of any refetch.
             */
            if (event.event === 'files.changed') git.observeFilesChanged(event.payload);
            send(event);
        },
        logger,
        () => config.getSettings().value['files.maxFileBytes'],
        {
            decorateGitIgnored: (sessionId, directory, names) =>
                git.ignoredEntries(sessionId, directory, names),
            fileTreeExcludes: () => config.getSettings().value['files.exclude'],
            mutationJournalPath: join(userDataPath, 'file-operations.json'),
            search: projectSearch,
            watchHub,
            // onRootUnavailable is a synchronous callback, so this cannot become await.
            onRootUnavailable: (sessionId) =>
                // eslint-disable-next-line unicorn/prefer-await -- sync callback signature
                workbenchRoots.validateSession(sessionId).catch((error: unknown) =>
                    logger.write('error', logEventCatalog.workbenchRoots.validateSessionFailed, {
                        fields: { sessionId, error: errorMessage(error, 'unknown') },
                    }),
                ),
        },
    );
    await files.initialize();
    return {
        acknowledgeFileMutation: (sessionId: string, operationId: string) =>
            acknowledgeFileMutation(database, files, sessionId, operationId),
        configuration: config,
        database,
        externalStatus,
        files,
        git,
        sessionContext,
        timeline,
        transcripts,
        watchHub,
        workbenchRoots,
    };
}
