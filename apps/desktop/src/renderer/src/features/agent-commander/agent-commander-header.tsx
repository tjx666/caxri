import type { ReactNode } from 'react';

import { commanderAgentSchema } from '@caxri/protocol';
import { HandHelping, MessageSquareWarning, PanelLeft } from 'lucide-react';

import { CaxriLogo } from '../../components/caxri-logo';
import { Button } from '../../components/ui/button';
import { Toggle } from '../../components/ui/toggle';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useIsFullScreen, useTerminal } from '../../stores/selectors';
import { AgentSurfaceToggle } from '../terminal/agent-surface-toggle';
import { canSwitchTerminalSurface } from '../terminal/terminal-surface-commands';
import { WindowZoomIndicator } from '../window-zoom/window-zoom-indicator';
import { CommanderAgentMenu } from './commander-agent-menu';
import { setCommanderBoardVisible, useCommanderBoardUiStore } from './commander-board-store';
import { useAgentCommanderStore } from './commander-client';
import { openCommanderHandover } from './commander-handover-store';
import { openCommanderInboxCount } from './commander-inbox';
import { setCommanderInboxVisible, useCommanderInboxUiStore } from './commander-inbox-store';
import { CommanderMoreMenu } from './commander-more-menu';
import { useCommanderInbox } from './hooks/use-commander-inbox';

/**
 * The zoom indicator in the title bar matches the ghost `sm` buttons beside it, muted like the Hand Over button.
 */
const HEADER_ZOOM_TRIGGER =
    'inline-flex min-h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[11px] text-muted outline-none hover:bg-[var(--selection)] focus-visible:shadow-[0_0_0_3px_var(--state-focus-ring)]';

/**
 * The window's whole title bar, and its drag region. Its left padding clears the macOS `hiddenInset` traffic lights,
 * the same zoom-aware clearance the Workbench's collapsed header uses; in fullscreen the traffic lights are gone, so
 * the clearance gives way to the logo, as it does in the Workbench's sidebar header. The column toggles follow the
 * layout from left to right (Sessions, then Needs you), and the Workbench tab rail's `Terminal | Chat` switch follows,
 * so the Commander opens as either surface with the same control and shortcut. The Agent the Commander runs sits beside
 * the title it qualifies; Stop and the rarer actions wait in the trailing More menu and the Command Palette, so the bar
 * keeps only what is used all the time.
 */
export function AgentCommanderHeader() {
    const { t } = useTranslation();
    const workspacePath = useAgentCommanderStore((state) => state.workspacePath);
    const terminalId = useAgentCommanderStore((state) => state.identity?.terminalId);
    const terminal = useTerminal(terminalId ?? '');
    const isBoardVisible = useCommanderBoardUiStore((state) => state.isVisible);
    const isFullScreen = useIsFullScreen();
    const agent = commanderAgentSchema.safeParse(terminal?.provider).data;
    return (
        <header
            className={cn(
                'agent-commander-header flex h-9 flex-none items-center gap-2 bg-surface pr-3 [-webkit-app-region:drag]',
                isFullScreen ? 'pl-3' : 'pl-(--traffic-light-clearance)',
            )}
        >
            {isFullScreen && <CaxriLogo />}
            {/*
             * The Commander's folder is a generated one whose name (`agent-commander`) read as a raw slug beside the
             * title, so the bar shows only the title and the folder's path waits in its tooltip. The title opts out of
             * the drag region when it has a tooltip: a drag region swallows the hover a tooltip needs.
             */}
            {workspacePath ? (
                <Tooltip content={workspacePath}>
                    <h1 className="agent-commander-title m-0 flex-none text-[13px] font-medium [-webkit-app-region:no-drag]">
                        {t('agentCommander.window.title')}
                    </h1>
                </Tooltip>
            ) : (
                <h1 className="agent-commander-title m-0 flex-none text-[13px] font-medium">
                    {t('agentCommander.window.title')}
                </h1>
            )}
            {agent && (
                <div className="flex-none [-webkit-app-region:no-drag]">
                    <CommanderAgentMenu agent={agent} />
                </div>
            )}
            <div className="ml-auto flex flex-none items-center gap-2 [-webkit-app-region:no-drag]">
                <WindowZoomIndicator side="bottom" triggerClassName={HEADER_ZOOM_TRIGGER} />
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
                        {t('agentCommander.handover.openEllipsis')}
                    </Button>
                </Tooltip>
                {terminal && canSwitchTerminalSurface(terminal) && (
                    <AgentSurfaceToggle terminal={terminal} />
                )}
                <CommanderMoreMenu />
            </div>
        </header>
    );
}

/**
 * Shows or hides one of the columns beside the Terminal. The visible label names the column and stays the accessible
 * name, `aria-pressed` carries whether it is open, and the tooltip says what a click does next.
 *
 * An open column reads as the shared Toggle's pressed fill plus a border, the same treatment as the `Terminal | Chat`
 * switch beside it: the shared Toggle paints hover and pressed alike, so without the border a hovered closed column
 * would look open.
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
            <Toggle
                size="dense"
                className={cn(className, 'gap-2 text-[11px] data-pressed:border-border')}
                pressed={isVisible}
                onPressedChange={onVisibleChange}
            >
                {icon}
                {label}
                {badge}
            </Toggle>
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
    const dismissingIds = useCommanderInboxUiStore((state) => state.dismissingIds);
    const count = data ? openCommanderInboxCount(data.items, dismissingIds) : 0;
    return (
        <CommanderColumnToggle
            badge={
                count > 0 && (
                    <span className="agent-commander-inbox-count rounded-full bg-badge px-1.5 text-[10px] leading-4 text-badge-foreground tabular-nums">
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
