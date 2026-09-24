import type { BootstrapState, FullStateChangeReason } from '@caxri/protocol';

import type { CaxriDatabase } from './db';
import type { DomainHandlers } from './domain-services';
import type { TerminalRestoreSupervisor, TerminalSuspensionService } from './terminal';

interface ProjectHidingHandlerOptions {
    database: CaxriDatabase;
    bootstrapState(): BootstrapState;
    evictSessions(sessionIds: readonly string[]): void;
    restoreSelection(): void;
    sendFullStateChange(reason: FullStateChangeReason): void;
    terminalRestores: Pick<TerminalRestoreSupervisor, 'cancel'>;
    terminalSuspension: Pick<TerminalSuspensionService, 'suspendSession'>;
}

/**
 * Hiding is the reversible alternative to `project.delete`: every record survives, so its Terminals take the same
 * suspension path as archiving rather than the termination deletion performs. Adding the Project's root again clears
 * the mark, and selecting one of its Sessions resumes the parked Terminals like any archived Session.
 */
export function createProjectHidingHandlers(
    options: ProjectHidingHandlerOptions,
): Pick<DomainHandlers, 'project.hide'> {
    return {
        'project.hide': async ({ projectId }) => {
            const sessionIds = options.database.hideProject(projectId).map((session) => session.id);
            for (const sessionId of sessionIds) options.terminalRestores.cancel(sessionId);
            await Promise.all(
                sessionIds.map((sessionId) => options.terminalSuspension.suspendSession(sessionId)),
            );
            options.evictSessions(sessionIds);
            options.restoreSelection();
            options.sendFullStateChange('project.hide');
            return options.bootstrapState();
        },
    };
}
