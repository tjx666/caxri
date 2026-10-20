import { refreshWatchSessionInBackground } from './background-tasks';
import type { CaxriDatabase } from './db';
import type { DomainDependencies } from './domain-services';
import { ProjectStatusService, VercelDeploymentStore } from './project-status';
import type { createRootServices } from './root-services';

type RootServices = Awaited<ReturnType<typeof createRootServices>>;

/**
 * Owns the Project Status slice lifecycle. Create: builds Project Status and the Vercel deployment store. Start: begins
 * the delivery watch and binds Project Status to Workbench Root changes. Close: the returned `dispose` stops the watch.
 * Its handlers are registered by `service-handlers.ts`; the composition root only orders this slice among the others.
 */
export function createStatusServices({
    configuration,
    database,
    externalStatus,
    files,
    git,
    logger,
    primaryVisibleSessionId,
    send,
    visibleSessionIds,
    sessionContext,
    workbenchRoots,
}: Pick<
    RootServices,
    'configuration' | 'externalStatus' | 'files' | 'git' | 'sessionContext' | 'workbenchRoots'
> &
    Pick<DomainDependencies, 'logger' | 'send'> & {
        database: CaxriDatabase;
        /**
         * The one visible Session the single-scope file watcher follows.
         */
        primaryVisibleSessionId: () => string | undefined;
        visibleSessionIds: () => ReadonlySet<string>;
    }): {
    dispose: () => void;
    projectStatus: ProjectStatusService;
    vercel: VercelDeploymentStore;
} {
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
        if (!visibleSessionIds().has(sessionId)) return;
        // Evicting dropped the Session from the poll set; the root change keeps it visible, so it is polled again.
        projectStatus.setPolledSessions(visibleSessionIds());
        if (primaryVisibleSessionId() === sessionId)
            refreshWatchSessionInBackground(files, git, logger, sessionId);
    });
    return { dispose: () => projectStatus.dispose(), projectStatus, vercel };
}
