import type { KeyboardEvent } from 'react';
import { useEffect } from 'react';

import { Columns2, X } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { isImeComposing } from '../../../lib/ime';
import { cn } from '../../../lib/utilities';
import {
    PORTAL_DEFAULT_WIDTH,
    PORTAL_MAX_WIDTH,
    PORTAL_MIN_WIDTH,
    useChromeLayoutStore,
} from '../../../stores/chrome-layout';
import { useSelectedSessionId, useTerminals } from '../../../stores/selectors';
import { EditorSurface } from '../../editor/editor-surface';
import { useDocumentTabPresentation } from '../../editor/hooks/use-document-tab-presentation';
import { WorkTabIcon } from '../../tabs/work-tab';
import { PaneViewSessionProvider } from '../../workbench/pane-view-session';
import { PanelDivider } from '../../workbench/panel-divider';
import { openPortalItemInSplit } from '../tasks/agent-chat-task-opener';
import { besideChatTabTerminalId } from '../tasks/beside-chat-layout';
import { usePortalItems, usePortalStore } from './portal-store';

/**
 * Stands in for a pane id: the beside-Chat surfaces `EditorSurface` renders here never read it.
 */
const PORTAL_SURFACE_PANE_ID = 'agent-chat-portal';

/**
 * The Portal: a flyout over the window's right edge that shows a Chat's subagent and background shell tasks, turn
 * reviews, Context breakdown, and side chat without splitting the Workbench (issue #2370). It covers the
 * SecondarySidebar when that is on screen, and the Chat's right edge otherwise, so opening one never reflows the Chat.
 *
 * Clicking back into the Chat leaves it open, so the user can read a subagent while typing to the main Agent. Escape
 * inside it, its X, or "Open in Split" (which turns the item into an ordinary pane tab) closes it.
 */
export function AgentChatPortal({ className }: { className?: string }) {
    const sessionId = useSelectedSessionId();
    const items = usePortalItems(sessionId);
    const width = useChromeLayoutStore((state) => state.portalWidth);
    useEffect(() => {
        document.documentElement.style.setProperty('--agent-chat-portal-width', `${width}px`);
    }, [width]);
    useRetainLivePortalItems(sessionId);
    const { activePath } = items;
    if (!sessionId || !activePath) return null;
    const closeOnEscape = (event: KeyboardEvent<HTMLElement>): void => {
        // A key the content already handled (a menu's or picker's own Escape) is not a request to close.
        if (event.key !== 'Escape' || event.defaultPrevented || isImeComposing(event)) return;
        event.preventDefault();
        usePortalStore.getState().closeAll(sessionId);
    };
    return (
        <PaneViewSessionProvider value={sessionId}>
            <aside
                data-agent-chat-portal=""
                className={cn(
                    'agent-chat-portal absolute top-0 right-0 bottom-0 z-20 flex',
                    'w-(--agent-chat-portal-width,480px) max-w-[calc(100%-320px)] min-w-0',
                    'border-l border-border bg-surface shadow-[0_8px_24px_var(--shadow)]',
                    className,
                )}
                onKeyDown={closeOnEscape}
            >
                <PortalResizeEdge width={width} />
                <div className="flex min-w-0 flex-1 flex-col">
                    <PortalHeader
                        activePath={activePath}
                        paths={items.paths}
                        sessionId={sessionId}
                    />
                    <div className="relative min-h-0 flex-1">
                        <EditorSurface
                            key={activePath}
                            paneId={PORTAL_SURFACE_PANE_ID}
                            path={activePath}
                        />
                    </div>
                </div>
            </aside>
        </PaneViewSessionProvider>
    );
}

function PortalResizeEdge({ width }: { width: number }) {
    const { t } = useTranslation();
    return (
        <div className="absolute inset-y-0 left-0 flex">
            <PanelDivider
                ariaLabel={t('agentChat.portal.resize')}
                size={width}
                min={PORTAL_MIN_WIDTH}
                max={PORTAL_MAX_WIDTH}
                defaultSize={PORTAL_DEFAULT_WIDTH}
                cssVariable="--agent-chat-portal-width"
                growDirection={-1}
                orientation="vertical"
                onCommit={(next) => useChromeLayoutStore.getState().setPortalWidth(next)}
            />
        </div>
    );
}

function PortalHeader({
    activePath,
    paths,
    sessionId,
}: {
    activePath: string;
    paths: readonly string[];
    sessionId: string;
}) {
    const { t } = useTranslation();
    const hasChoices = paths.length > 1;
    return (
        <div className="flex h-9 flex-none items-center gap-1 border-b border-border pr-1 pl-2">
            <div
                role={hasChoices ? 'tablist' : undefined}
                aria-label={t('agentChat.portal.label')}
                className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
            >
                {paths.map((path) => (
                    <PortalTab
                        key={path}
                        hasChoices={hasChoices}
                        isActive={path === activePath}
                        path={path}
                        sessionId={sessionId}
                    />
                ))}
            </div>
            <Tooltip content={t('agentChat.portal.openInSplit')}>
                <Button
                    aria-label={t('agentChat.portal.openInSplit')}
                    size="icon"
                    variant="ghost"
                    onClick={() => openPortalItemInSplit(sessionId, activePath)}
                >
                    <Columns2 aria-hidden="true" size={14} />
                </Button>
            </Tooltip>
            <Tooltip content={t('agentChat.portal.close')} shortcut="escape">
                <Button
                    aria-label={t('agentChat.portal.close')}
                    size="icon"
                    variant="ghost"
                    onClick={() => usePortalStore.getState().closeAll(sessionId)}
                >
                    <X aria-hidden="true" size={14} />
                </Button>
            </Tooltip>
        </div>
    );
}

/**
 * One item in the Portal header. A lone item is a plain title: there is nothing to switch to, so it draws no selection
 * and no close button of its own (the header's X closes it). Two or more become tabs.
 */
function PortalTab({
    hasChoices,
    isActive,
    path,
    sessionId,
}: {
    hasChoices: boolean;
    isActive: boolean;
    path: string;
    sessionId: string;
}) {
    const { t } = useTranslation();
    const presentation = useDocumentTabPresentation(path, undefined);
    const content = (
        <>
            <WorkTabIcon {...presentation} />
            <span className="truncate">{presentation.label}</span>
        </>
    );
    if (!hasChoices)
        return (
            <div className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium">
                {content}
            </div>
        );
    return (
        <div
            className={cn(
                'group flex h-7 min-w-0 flex-none items-center rounded-md text-[12px]',
                isActive
                    ? 'bg-[var(--selection)] text-foreground'
                    : 'text-muted hover:bg-[var(--selection)] hover:text-foreground',
            )}
        >
            <button
                type="button"
                role="tab"
                aria-selected={isActive}
                className="flex min-w-0 items-center gap-1.5 py-1 pl-2"
                onClick={() => usePortalStore.getState().select(sessionId, path)}
            >
                {content}
            </button>
            <button
                type="button"
                aria-label={t('agentChat.portal.closeItem', { label: presentation.label })}
                className={cn(
                    'mx-0.5 flex size-5 flex-none items-center justify-center rounded-sm hover:bg-[var(--selection)]',
                    !isActive && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                )}
                onClick={() => usePortalStore.getState().close(sessionId, path)}
            >
                <X aria-hidden="true" size={12} />
            </button>
        </div>
    );
}

/**
 * Drops Portal items whose Chat is gone, so closing a Chat never leaves its subagent floating over another one.
 */
function useRetainLivePortalItems(sessionId: string | undefined): void {
    const terminals = useTerminals();
    useEffect(() => {
        if (!sessionId) return;
        const live = new Set(terminals.map((terminal) => terminal.id));
        usePortalStore.getState().retain(sessionId, (path) => {
            const terminalId = besideChatTabTerminalId(path);
            return terminalId !== undefined && live.has(terminalId);
        });
    }, [sessionId, terminals]);
}
