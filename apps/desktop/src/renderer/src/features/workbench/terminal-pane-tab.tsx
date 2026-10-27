import type { PaneTab, TerminalRecord } from '@caxri/protocol';
import { terminalDisplayTitle, terminalTabLabel } from '@caxri/protocol';
import { CircleAlert, Pause } from 'lucide-react';

import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useSessionState } from '../../stores/selectors';
import { WorkTab } from '../tabs/work-tab';
import type { WorkTabNavigationKey } from '../tabs/work-tab-accessibility';
import { workTabId } from '../tabs/work-tab-accessibility';
import { closeTerminal } from '../terminal/terminal-commands';
import {
    terminalProgressAriaLabel,
    terminalProgressLabel,
    useTerminalProgress,
} from '../terminal/terminal-progress';
import { terminalTabMenuEntries } from '../terminal/terminal-tab-menu';
import { terminalTabTooltip } from '../terminal/terminal-tab-presentation';
import { selectPaneTab } from './pane-actions';
import { PANE_TAB_DRAG_TYPE } from './pane-drop-zone';
import { paneTabMenu } from './pane-tab-menu';
import { usePaneViewSessionId } from './pane-view-session';

/**
 * What every pane tab receives from `PaneTabEntry`, whatever resource it holds.
 */
export interface PaneTabProperties {
    active: boolean;
    /**
     * Forwarded to `WorkTab`; `false` for the Workbench's lone tab. See `WorkTab`'s own property doc.
     */
    closable: boolean;
    onNavigate: (key: WorkTabNavigationKey) => void;
    paneId: string;
    /**
     * Forwarded to `WorkTab`; `false` for the Workbench's lone tab. See `WorkTab`'s own property doc.
     */
    showActiveAccent: boolean;
    /**
     * Forwarded to `WorkTab`; `false` for the last tab in this pane's rail. See `WorkTab`'s own property doc.
     */
    showTrailingSeparator: boolean;
    tab: PaneTab;
}

/**
 * A Terminal's pane tab: its title, progress or compaction accessory, and the Terminal tab context menu.
 */
export function TerminalPaneTab({
    active,
    closable,
    isOnlySessionTerminal,
    onNavigate,
    paneId,
    showActiveAccent,
    showTrailingSeparator,
    tab,
    terminal,
}: PaneTabProperties & { isOnlySessionTerminal: boolean; terminal: TerminalRecord }) {
    const { t } = useTranslation();
    const paneLayout = useSessionState(usePaneViewSessionId())?.paneLayout;
    const progress = useTerminalProgress(terminal.id);
    const isCompacting = terminal.agentOperation === 'compacting';
    const ProgressIcon =
        progress?.kind === 'error' ? CircleAlert : progress?.kind === 'paused' ? Pause : undefined;
    const title = terminalDisplayTitle(terminal);
    return (
        <WorkTab
            active={active}
            fill
            accessory={
                isCompacting ? (
                    <Tooltip content={t('workbench.tab.compactingTooltip')}>
                        <span
                            aria-label={t('workbench.tab.compacting')}
                            aria-live="polite"
                            className="terminal-agent-operation inline-flex flex-none items-center text-foreground"
                            data-agent-operation="compacting"
                            role="status"
                        >
                            Compacting
                        </span>
                    </Tooltip>
                ) : progress ? (
                    <span
                        aria-label={terminalProgressAriaLabel(progress, t)}
                        className={cn(
                            'terminal-progress-tab inline-flex flex-none items-center gap-1 tabular-nums',
                            /**
                             * `--accent` marks exactly one thing at a time: the focused pane/tab (DESIGN.md principle
                             * 2). This badge renders on every tab with progress, active or not, so a background `npm
                             * install` must not wear the same accent color the focused tab's ring already owns.
                             */
                            progress.kind === 'normal' && 'text-muted',
                            progress.kind === 'error' && 'text-danger',
                            progress.kind === 'paused' && 'text-warning',
                        )}
                        data-terminal-progress-state={progress.kind}
                        title={terminalProgressAriaLabel(progress, t)}
                    >
                        {progress.kind === 'indeterminate' ? (
                            <Spinner aria-hidden="true" size={11} />
                        ) : (
                            ProgressIcon && <ProgressIcon aria-hidden="true" size={11} />
                        )}
                        {progress.kind !== 'indeterminate' && terminalProgressLabel(progress, t)}
                    </span>
                ) : undefined
            }
            closable={closable}
            closeLabel={t('workbench.tab.closeTerminal')}
            icon={terminal.kind}
            label={terminalTabLabel(title)}
            labelTooltip={terminalTabTooltip(title, terminal, t)}
            showActiveAccent={showActiveAccent}
            showTrailingSeparator={showTrailingSeparator}
            tabId={workTabId(tab.id)}
            paneTabId={tab.id}
            terminalId={terminal.id}
            onClose={() => closeTerminal(terminal.id)}
            onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(PANE_TAB_DRAG_TYPE, tab.id);
            }}
            onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                onNavigate(event.key as WorkTabNavigationKey);
            }}
            onSelect={() => selectPaneTab(tab.id)}
            contextMenu={async () =>
                paneTabMenu({
                    paneId,
                    paneLayout,
                    tabId: tab.id,
                    resourceEntries: await terminalTabMenuEntries(terminal, isOnlySessionTerminal),
                })
            }
        />
    );
}
