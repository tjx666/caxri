import { Plus } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import { useWorkbenchStore } from '../../stores/workbench';
import { SessionTabCreateMenu } from '../session/create-session-menu';

/**
 * The same `Button` as the pane row's `+` (28px square, radius 8, `--selection` hover), so the two read as one control
 * at two levels. Its keyboard focus is the tabs' inset 1px outline rather than `Button`'s accent glow: the strip must
 * not spend a second accent, and one focus language keeps tabbing through the strip consistent.
 */
const BUTTON_CLASS =
    'text-muted hover:text-foreground focus-visible:border-transparent focus-visible:shadow-none focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-foreground data-[popup-open]:bg-[var(--selection)] data-[popup-open]:text-foreground';

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
        <Button
            aria-label={label}
            className={BUTTON_CLASS}
            disabled={!project}
            size="icon"
            variant="ghost"
        >
            <Plus size={14} />
        </Button>
    );
    return (
        <div className="session-tab-new sticky right-0 z-[5] flex h-9 flex-none items-center bg-title-bar-active-background pl-1 [-webkit-app-region:no-drag] window-inactive:bg-title-bar-inactive-background">
            {project ? <SessionTabCreateMenu project={project} trigger={button} /> : button}
        </div>
    );
}
