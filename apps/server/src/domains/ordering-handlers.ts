import type { FullStateChangeReason } from '@caxri/protocol';

import type { CaxriDatabase } from './db';
import type { DomainHandlers } from './domain-services';

interface OrderingHandlerOptions {
    database: CaxriDatabase;
    sendFullStateChange: (reason: FullStateChangeReason) => void;
}

/**
 * The four methods that rearrange the Primary Side Bar. None of them changes what exists or which Session is selected:
 * they only record where a row sits, so each one answers with a full state change and nothing else.
 *
 * Pinning lives here rather than beside archiving because it is an ordering decision: `session.setPinned` decides
 * whether a Session appears in the Pinned group at all, and `session.reorderPinned` decides where inside it. Neither
 * touches the Session's place in its own Project group, which `session.reorder` owns.
 */
export function createOrderingHandlers({
    database,
    sendFullStateChange,
}: OrderingHandlerOptions): Pick<
    DomainHandlers,
    'project.reorder' | 'session.reorder' | 'session.reorderPinned' | 'session.setPinned'
> {
    return {
        'project.reorder': ({ projectId, targetIndex }) => {
            const reordered = database.reorderProject(projectId, targetIndex);
            sendFullStateChange('project.reorder');
            return reordered;
        },
        'session.reorder': ({ sessionId, anchorSessionId, placement }) => {
            database.reorderSession(sessionId, anchorSessionId, placement);
            sendFullStateChange('session.reorder');
            return null;
        },
        'session.reorderPinned': ({ sessionId, anchorSessionId, placement }) => {
            database.reorderPinnedSession(sessionId, anchorSessionId, placement);
            sendFullStateChange('session.reorderPinned');
            return null;
        },
        'session.setPinned': ({ sessionId, pinned: shouldPin }) => {
            const session = database.setSessionPinned(sessionId, shouldPin);
            sendFullStateChange('session.setPinned');
            return session;
        },
    };
}
