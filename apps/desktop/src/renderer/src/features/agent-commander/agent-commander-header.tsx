import type { ReactNode } from 'react';

import { MessageSquareWarning, PanelLeft, Power } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import { useProjectById, useTerminal } from '../../stores/selectors';
import { AgentSurfaceToggle } from '../terminal/agent-surface-toggle';
import { canSwitchTerminalSurface } from '../terminal/terminal-surface-commands';
import { setCommanderBoardVisible, useCommanderBoardUiStore } from './commander-board-store';
import { useAgentCommanderStore } from './commander-client';
import { stopCommander } from './commander-commands';
import { openCommanderInboxCount } from './commander-inbox';
import { setCommanderInboxVisible, useCommanderInboxUiStore } from './commander-inbox-store';
import { useCommanderInbox } from './hooks/use-commander-inbox';

/**
 * The window's whole title bar, and its drag region. Its left padding clears the macOS `hiddenInset` traffic lights,
 * the same zoom-aware clearance the Workbench's collapsed header uses. The column toggles follow the layout from left
 * to right (Sessions, then Needs you), and the Workbench tab rail's `Terminal | Chat` switch sits beside Stop, so the
 * Commander opens as either surface with the same control and shortcut.
 */
export function AgentCommanderHeader() {
    const workspacePath = useAgentCommanderStore((state) => state.workspacePath);
    const terminalId = useAgentCommanderStore((state) => state.identity?.terminalId);
    const projectId = useAgentCommanderStore((state) => state.identity?.projectId);
    const projectTitle = useProjectById(projectId)?.displayTitle;
    const terminal = useTerminal(terminalId ?? '');
    const isBoardVisible = useCommanderBoardUiStore((state) => state.isVisible);
    return (
        <header className="agent-commander-header flex h-11 flex-none items-center gap-2 bg-surface pr-3 pl-(--traffic-light-clearance) [-webkit-app-region:drag]">
            <h1 className="m-0 flex-none text-[13px] font-medium">Agent Commander</h1>
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
                    label="Sessions"
                    onVisibleChange={setCommanderBoardVisible}
                />
                <InboxToggle />
                {terminal && canSwitchTerminalSurface(terminal) && (
                    <AgentSurfaceToggle terminal={terminal} />
                )}
                <Tooltip content="Stop the Commander and close this window. Tasks it delegated keep running, and opening it again resumes the same conversation.">
                    <Button
                        variant="ghost"
                        size="sm"
                        className="agent-commander-stop text-muted"
                        onClick={stopCommander}
                    >
                        <Power size={13} />
                        Stop
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
    return (
        <Tooltip content={`${isVisible ? 'Hide' : 'Show'} ${label}`}>
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
            label="Needs you"
            onVisibleChange={setCommanderInboxVisible}
        />
    );
}
