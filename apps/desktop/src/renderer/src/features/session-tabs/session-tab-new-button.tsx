import { Plus } from 'lucide-react';

import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { useCommandShortcut } from '../../lib/keybindings';
import { useWorkbenchStore } from '../../stores/workbench';
import { beginSessionCreation } from '../session/session-creation-commands';

/**
 * The strip's trailing `+`: a new Session in the active Session's Project, started the way `Cmd+N` starts one (the
 * configured default Agent, else the Agent list), but opened as a new tab. It sticks to the rail's right edge so it
 * stays reachable when the tabs overflow, and it is the only part of the strip's end that is not a window drag region.
 */
export function SessionTabNewButton() {
    const { t } = useTranslation();
    const shortcut = useCommandShortcut('session.create');
    const projectId = useWorkbenchStore((state) => {
        const selectedId = state.bootstrap?.selectedSessionId;
        return state.bootstrap?.sessions.find((session) => session.id === selectedId)?.projectId;
    });
    const label = t('sessionTabs.new');
    return (
        <div className="session-tab-new sticky right-0 z-[5] flex h-11 flex-none items-center bg-title-bar-active-background px-1 [-webkit-app-region:no-drag] window-inactive:bg-title-bar-inactive-background">
            <Tooltip content={label} shortcut={shortcut}>
                <button
                    type="button"
                    aria-label={label}
                    disabled={!projectId}
                    className="flex size-9 cursor-pointer items-center justify-center rounded-lg text-muted outline-none hover:bg-tab-hover-background hover:text-tab-hover-foreground focus-visible:shadow-[0_0_0_2px_var(--accent)] disabled:cursor-not-allowed disabled:opacity-45"
                    onClick={() => {
                        if (projectId) beginSessionCreation(projectId, 'heading', 'newTab');
                    }}
                >
                    <Plus size={14} />
                </button>
            </Tooltip>
        </div>
    );
}
