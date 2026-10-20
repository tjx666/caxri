import { Plus } from 'lucide-react';

import { useTranslation } from '../../i18n';
import { useWorkbenchStore } from '../../stores/workbench';
import { SessionTabCreateMenu } from '../session/create-session-menu';

const BUTTON_CLASS =
    'flex size-9 cursor-pointer items-center justify-center rounded-lg text-muted outline-none hover:bg-tab-hover-background hover:text-tab-hover-foreground focus-visible:shadow-[0_0_0_2px_var(--accent)] disabled:cursor-not-allowed disabled:opacity-45 data-[popup-open]:bg-tab-hover-background data-[popup-open]:text-tab-hover-foreground';

/**
 * The strip's trailing `+`: a new Session in the active Session's Project, started the way `Cmd+N` starts one (the
 * configured default Agent, else the Agent list hung from this button), but opened as a new tab. It sticks to the
 * rail's right edge so it stays reachable when the tabs overflow, and it is the only part of the strip's end that is
 * not a window drag region.
 */
export function SessionTabNewButton() {
    const { t } = useTranslation();
    const project = useWorkbenchStore((state) => {
        const bootstrap = state.bootstrap;
        const projectId = bootstrap?.sessions.find(
            (session) => session.id === bootstrap.selectedSessionId,
        )?.projectId;
        return bootstrap?.projects.find((candidate) => candidate.id === projectId);
    });
    const label = t('sessionTabs.new');
    const button = (
        <button type="button" aria-label={label} disabled={!project} className={BUTTON_CLASS}>
            <Plus size={14} />
        </button>
    );
    return (
        <div className="session-tab-new sticky right-0 z-[5] flex h-11 flex-none items-center bg-title-bar-active-background px-1 [-webkit-app-region:no-drag] window-inactive:bg-title-bar-inactive-background">
            {project ? <SessionTabCreateMenu project={project} trigger={button} /> : button}
        </div>
    );
}
