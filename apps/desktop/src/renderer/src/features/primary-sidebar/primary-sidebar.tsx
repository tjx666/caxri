import { TriangleAlert } from 'lucide-react';

import { SurfaceErrorBoundary } from '../../components/surface-error-boundary';
import { Button } from '../../components/ui/button';
import { Empty, EmptyMedia, EmptyTitle } from '../../components/ui/empty';
import { useTranslation } from '../../i18n';
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
            {isActivityMode ? (
                <SurfaceErrorBoundary
                    fallback={({ reset }) => <ActivityFailure reset={reset} />}
                    resetKey="activity"
                    scope="activity"
                >
                    <AgentActivityView />
                </SurfaceErrorBoundary>
            ) : (
                <PrimarySidebarProjectTree />
            )}
            <PrimarySidebarFooter archivedCount={archivedCount} />
        </aside>
    );
}

/**
 * Fallback for a failing Activity body: the persisted Activity mode would bring the same failure back on every load, so
 * the way out is the Project tree, with Retry for a transient failure.
 */
function ActivityFailure({ reset }: { reset: () => void }) {
    const { t } = useTranslation();
    return (
        <Empty className="empty-work min-h-0 flex-1" role="alert">
            <EmptyMedia>
                <TriangleAlert aria-hidden="true" className="text-danger" size={28} />
            </EmptyMedia>
            <EmptyTitle className="max-w-60 text-pretty">
                {t('core.surfaceBoundary.message')}
            </EmptyTitle>
            <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={reset}>
                    {t('common.retry')}
                </Button>
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                        useChromeLayoutStore.getState().leavePrimarySidebarActivityMode()
                    }
                >
                    {t('primarySidebar.header.showProjects')}
                </Button>
            </div>
        </Empty>
    );
}
