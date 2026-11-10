import { ChevronRight } from 'lucide-react';

import { useTranslation } from '../../i18n';
import { isPrimarySidebarShown, useChromeLayoutStore } from '../../stores/chrome-layout';
import { useProjectById } from '../../stores/selectors';
import { ProjectIcon } from '../primary-sidebar/project-icon';
import { usePaneViewSession } from './pane-view-session';

/**
 * The pane Session's Project, shown at the leading edge of the title bar while the Primary Sidebar is hidden. The side
 * bar is otherwise the only place that says which Project the open Session belongs to, so hiding it would leave the
 * Workbench showing a Session title with no Project at all. It stays inside the bar's drag region and takes no input:
 * it is a breadcrumb, not a Project switcher.
 */
export function TitleBarProjectLabel({
    isRootBar,
}: {
    /**
     * Only the bar that doubles as the window title bar carries the label; a split pane's own bar never does.
     */
    isRootBar: boolean;
}) {
    const { t } = useTranslation();
    const isPrimarySidebarVisible = useChromeLayoutStore(isPrimarySidebarShown);
    const project = useProjectById(usePaneViewSession()?.projectId);
    if (!isRootBar || isPrimarySidebarVisible || !project) return null;
    return (
        <div
            aria-label={t('workbench.titleBar.project', { title: project.title })}
            className="title-bar-project-label flex max-w-48 min-w-0 flex-none items-center gap-1.5 pr-1 pl-2 text-[12px] text-muted"
            data-project-id={project.id}
            role="note"
        >
            <ProjectIcon className="flex-none" icon={project.icon} size={13} />
            <span className="min-w-0 truncate">{project.title}</span>
            <ChevronRight aria-hidden="true" className="flex-none opacity-60" size={12} />
        </div>
    );
}
