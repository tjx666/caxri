import type { AutomaticNamingNotice, BootstrapState } from '@caxri/protocol';

import { translate } from '../i18n';
import { pushToast } from './toasts';

/**
 * `${sessionId}:${launchId}` for every automatic-naming notice this window has already shown.
 *
 * The live `agent.automaticNamingUnavailable` event is transient, so a failure that happens while macOS has no window
 * open is simply dropped: the user would come back to a Session that silently kept its placeholder name. The Server
 * therefore replays every suppression that is still in force in each bootstrap snapshot, which means a plain reconnect
 * would re-toast a failure the user already read, unless the window remembers what it reported. A window that was
 * actually closed and reopened starts empty and sees each notice exactly once.
 */
const reportedLaunches = new Set<string>();

/**
 * Names the Session for the user, so a background failure can be told apart from the other open Sessions.
 */
function describeSubject(bootstrap: BootstrapState | undefined, sessionId: string): string {
    const session = bootstrap?.sessions.find((item) => item.id === sessionId);
    const project = bootstrap?.projects.find((item) => item.id === session?.projectId);
    return [project?.displayTitle, session?.displayTitle].filter(Boolean).join(' / ') || 'Agent';
}

/**
 * Shows the notices this window has not shown yet, whichever path delivered them.
 */
export function reportAutomaticNamingNotices(
    notices: readonly AutomaticNamingNotice[] | undefined,
    bootstrap: BootstrapState | undefined,
): void {
    const pending = notices ?? [];
    for (const notice of pending) {
        const launch = `${notice.sessionId}:${notice.launchId}`;
        if (reportedLaunches.has(launch)) continue;
        reportedLaunches.add(launch);
        const subject = describeSubject(bootstrap, notice.sessionId);
        pushToast(
            'info',
            translate(
                notice.reason === 'sandboxBoundaryConflict'
                    ? 'core.automaticNaming.sandboxBoundaryConflict'
                    : 'core.automaticNaming.unverifiedPaths',
                { subject },
            ),
        );
    }
}
