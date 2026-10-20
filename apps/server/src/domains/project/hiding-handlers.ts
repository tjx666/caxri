import { realpath } from 'node:fs/promises';

import type { BootstrapState } from '@caxri/protocol';

import type { DomainHandlers } from '../domain-services';
import type { SessionParkingOptions } from '../parking-handlers';
import { parkSessions } from '../parking-handlers';

interface ProjectHidingHandlerOptions extends SessionParkingOptions {
    bootstrapState(windowKey?: string): BootstrapState;
}

/**
 * Hiding is the reversible alternative to `project.delete`: every record survives, so its Sessions take the same
 * parking path as archiving (PTYs suspended, Chats stopped) rather than the termination deletion performs. Adding the
 * Project's root again clears the mark, and selecting one of its Sessions resumes the parked Terminals like any
 * archived Session. The Project lock mirrors `project.delete`: a Terminal move or mobile Agent submit already holding
 * it finishes before the Sessions are parked.
 */
export function createProjectHidingHandlers(
    options: ProjectHidingHandlerOptions,
): Pick<DomainHandlers, 'project.hide' | 'project.restorable'> {
    return {
        'project.hide': ({ projectId, windowKey }) =>
            options.mobileTerminalMutations.runProject(projectId, async () => {
                const hidden = options.database.hideProject(projectId).map((session) => session.id);
                await options.mobileTerminalMutations.runSessions(hidden, () =>
                    parkSessions(options, hidden, 'project.hide'),
                );
                return options.bootstrapState(windowKey);
            }),
        /**
         * Rows store canonical roots, so the picked folder is resolved the way `project.create` resolves it. A folder
         * that no longer resolves cannot restore anything.
         */
        'project.restorable': async ({ rootPath }) => {
            let canonicalRoot: string;
            try {
                canonicalRoot = await realpath(rootPath);
            } catch {
                return false;
            }
            return options.database.isRestorableProjectRoot(canonicalRoot);
        },
    };
}
