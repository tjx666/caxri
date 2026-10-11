import { refreshWatchSessionInBackground } from './background-tasks';
import type { CaxriDatabase } from './db';
import type { DomainDependencies } from './domain-services';
import { ProjectStatusService, VercelDeploymentStore } from './project-status';
import type { createRootServices } from './root-services';

type RootServices = Awaited<ReturnType<typeof createRootServices>>;

/**
 * Builds Project Status with its delivery watch and binds it to Workbench Root changes. Kept out of
 * `create-domain-services.ts` to stay under the file's physical-line budget.
 */
export function createStatusServices({
    configuration,
    database,
    externalStatus,
    files,
    git,
    logger,
    selectedSessionId,
    send,
    sessionContext,
    workbenchRoots,
}: Pick<
    RootServices,
    'configuration' | 'externalStatus' | 'files' | 'git' | 'sessionContext' | 'workbenchRoots'
> &
    Pick<DomainDependencies, 'logger' | 'send'> & {
        database: CaxriDatabase;
        selectedSessionId: () => string | undefined;
    }): { projectStatus: ProjectStatusService; vercel: VercelDeploymentStore } {
    const vercel = new VercelDeploymentStore(externalStatus.run);
    const projectStatus = new ProjectStatusService(git, logger, externalStatus.run, {
        emit: send,
        github: externalStatus.github,
        listWatchedSessions: () =>
            database
                .listVisibleSessions()
                .filter((session) => session.archivedAt === undefined)
                .map((session) => session.id),
        sessionContext: (sessionId) => sessionContext.readSession(sessionId),
        settings: () => configuration.getSettings().value,
        vercel,
    });
    projectStatus.startDeliveryWatch();
    workbenchRoots.setRootChangedHandler((sessionId) => {
        /**
         * Root changes end the old projection lifetime before consumers re-read. An inactive root has no file watcher,
         * so retaining its settled Git snapshot can keep both Source Control and its badge stale when returning.
         */
        git.evictSessions([sessionId]);
        projectStatus.evictSessions([sessionId]);
        if (selectedSessionId() === sessionId) {
            projectStatus.setPolledSession(sessionId);
            refreshWatchSessionInBackground(files, git, logger, sessionId);
        }
    });
    return { projectStatus, vercel };
}
