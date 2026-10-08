import { useChromeLayoutStore } from '../../stores/chrome-layout';
import { useIsFullScreen, useSessions } from '../../stores/selectors';
import { AgentActivityView } from '../agent-activity/agent-activity-view';
import { PrimarySidebarFooter } from './primary-sidebar-footer';
import { PrimarySidebarHeader } from './primary-sidebar-header';
import { PrimarySidebarProjectTree } from './primary-sidebar-project-tree';

const NO_RECORDS: never[] = [];

/**
 * The Primary Side Bar's shell: a header, a footer, and exactly one of two bodies.
 *
 * The two bodies answer different questions: the tree answers "which Sessions exist", in the order the user arranged,
 * while Activity answers "which ones are waiting on me", across every Project and ordered by state. Neither order can
 * hold the other, so they take turns in the same column rather than sitting side by side; the header's inbox toggle
 * switches between them.
 *
 * Switching unmounts the body that leaves. Keeping both alive would mean a hidden Project tree still polling pull
 * requests, or a hidden queue still re-projecting every Session on the retention clock, to preserve a scroll position
 * behind a surface the user cannot see.
 */
export function PrimarySidebar() {
    const isFullScreen = useIsFullScreen();
    const sessions = useSessions() ?? NO_RECORDS;
    const isActivityMode = useChromeLayoutStore((state) => state.primarySidebarActivityMode);
    const archivedCount = sessions.filter((session) => session.archivedAt !== undefined).length;

    return (
        <aside className="session-primary-sidebar flex min-w-0 flex-col bg-surface">
            <PrimarySidebarHeader isActivityMode={isActivityMode} isFullScreen={isFullScreen} />
            {isActivityMode ? <AgentActivityView /> : <PrimarySidebarProjectTree />}
            <PrimarySidebarFooter archivedCount={archivedCount} />
        </aside>
    );
}
