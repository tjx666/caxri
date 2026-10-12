import type { ReactNode } from 'react';

import { HandHelping, MessageSquareWarning, PanelLeft, Power } from 'lucide-react';

import { CaxriLogo } from '../../components/caxri-logo';
import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useIsFullScreen, useProjectById, useTerminal } from '../../stores/selectors';
import { AgentSurfaceToggle } from '../terminal/agent-surface-toggle';
import { canSwitchTerminalSurface } from '../terminal/terminal-surface-commands';
import { setCommanderBoardVisible, useCommanderBoardUiStore } from './commander-board-store';
import { useAgentCommanderStore } from './commander-client';
import { stopCommander } from './commander-commands';
import { openCommanderHandover } from './commander-handover-store';
import { openCommanderInboxCount } from './commander-inbox';
import { setCommanderInboxVisible, useCommanderInboxUiStore } from './commander-inbox-store';
import { useCommanderInbox } from './hooks/use-commander-inbox';

/**
 * The window's whole title bar, and its drag region. Its left padding clears the macOS `hiddenInset` traffic lights,
 * the same zoom-aware clearance the Workbench's collapsed header uses; in fullscreen the traffic lights are gone, so
 * the clearance gives way to the logo, as it does in the Workbench's sidebar header. The column toggles follow the
 * layout from left to right (Sessions, then Needs you), and the Workbench tab rail's `Terminal | Chat` switch sits
 * beside Stop, so the Commander opens as either surface with the same control and shortcut.
 */
export function AgentCommanderHeader() {
    const { t } = useTranslation();
    const workspacePath = useAgentCommanderStore((state) => state.workspacePath);
    const terminalId = useAgentCommanderStore((state) => state.identity?.terminalId);
    const projectId = useAgentCommanderStore((state) => state.identity?.projectId);
    const projectTitle = useProjectById(projectId)?.displayTitle;
    const terminal = useTerminal(terminalId ?? '');
    const isBoardVisible = useCommanderBoardUiStore((state) => state.isVisible);
    const isFullScreen = useIsFullScreen();
    return (
        <header
            className={cn(
                'agent-commander-header flex h-11 flex-none items-center gap-2 bg-surface pr-3 [-webkit-app-region:drag]',
                isFullScreen ? 'pl-3' : 'pl-(--traffic-light-clearance)',
            )}
        >
            {isFullScreen && <CaxriLogo />}
            <h1 className="m-0 flex-none text-[13px] font-medium">
                {t('agentCommander.window.title')}
            </h1>
            {workspacePath && (
                /*
                 * The workspace is a long generated folder, so the bar names its Project and the full path waits in
                 * the tooltip. The label opts out of the drag region: a drag region swallows the hover a tooltip needs.
                 */
                <Tooltip content={workspacePath}>
                    <span className="agent-commander-workspace min-w-0 truncate text-[12px] text-muted [-webkit-app-region:no-drag]">
                        {projectTitle ?? workspacePath.split('/').at(-1)}
                    </span>
                </Tooltip>
            )}
            <div className="ml-auto flex flex-none items-center gap-2 [-webkit-app-region:no-drag]">
                <CommanderColumnToggle
                    className="agent-commander-board-toggle"
                    icon={<PanelLeft size={13} />}
                    isVisible={isBoardVisible}
                    label={t('agentCommander.window.sessionsLabel')}
                    onVisibleChange={setCommanderBoardVisible}
                />
                <InboxToggle />
                <Tooltip content={t('agentCommander.handover.openTooltip')}>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="agent-commander-handover text-muted"
                        onClick={() => openCommanderHandover()}
                    >
                        <HandHelping size={13} />
                        {t('agentCommander.handover.open')}
                    </Button>
                </Tooltip>
                {terminal && canSwitchTerminalSurface(terminal) && (
                    <AgentSurfaceToggle terminal={terminal} />
                )}
                <Tooltip content={t('agentCommander.window.stopTooltip')}>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="agent-commander-stop text-muted"
                        onClick={stopCommander}
                    >
                        <Power size={13} />
                        {t('agentCommander.window.stop')}
                    </Button>
                </Tooltip>
            </div>
        </header>
    );
}

/**
 * Shows or hides one of the columns beside the Terminal. The visible label names the column and stays the accessible
 * name, `aria-pressed` carries whether it is open, and the tooltip says what a click does next.
 */
function CommanderColumnToggle({
    badge,
    className,
    icon,
    isVisible,
    label,
    onVisibleChange,
}: {
    badge?: ReactNode;
    className: string;
    icon: ReactNode;
    isVisible: boolean;
    label: string;
    onVisibleChange: (isVisible: boolean) => void;
}) {
    const { t } = useTranslation();
    return (
        <Tooltip
            content={t(
                isVisible ? 'agentCommander.window.hideColumn' : 'agentCommander.window.showColumn',
                { column: label },
            )}
        >
            <Button
                aria-pressed={isVisible}
                variant="ghost"
                size="sm"
                className={cn(className, 'text-muted')}
                onClick={() => onVisibleChange(!isVisible)}
            >
                {icon}
                {label}
                {badge}
            </Button>
        </Tooltip>
    );
}

/**
 * The Inbox column's toggle, counting the open items so a hidden Inbox still says that something waits. Its flagged
 * message is the Commander Inbox's own glyph: the `Inbox` tray marks the Peer Inbox's held peer messages, and the bell
 * belongs to the status bar's notification center.
 */
function InboxToggle() {
    const { t } = useTranslation();
    const isVisible = useCommanderInboxUiStore((state) => state.isVisible);
    const { data } = useCommanderInbox();
    const count = data ? openCommanderInboxCount(data.items) : 0;
    return (
        <CommanderColumnToggle
            badge={
                count > 0 && (
                    <span className="agent-commander-inbox-count rounded-full bg-badge px-1.5 text-[10px] leading-4 text-badge-foreground">
                        {count}
                    </span>
                )
            }
            className="agent-commander-inbox-toggle"
            icon={<MessageSquareWarning size={13} />}
            isVisible={isVisible}
            label={t('agentCommander.window.needsYou')}
            onVisibleChange={setCommanderInboxVisible}
        />
    );
}
