import type { KeyboardEvent } from 'react';
import { useRef } from 'react';

import { parseAgentDelegationTab } from '@caxri/protocol';
import { Columns2, Maximize2, Minimize2, SquareArrowOutUpRight, X } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { useTerminal } from '../../../stores/selectors';
import { useDocumentTabPresentation } from '../../editor/hooks/use-document-tab-presentation';
import { openSession } from '../../session/session-commands';
import { WorkTabIcon } from '../../tabs/work-tab';
import { openPortalItemInSplit } from '../tasks/agent-chat-task-opener';
import { nextPortalTabPath, portalTabId } from './portal-keys';
import { usePortalStore } from './portal-store';

/**
 * The Side View's header: its items as tabs (a lone item is a plain title), Open in Split (Open Session for a delegated
 * child, whose Chat belongs to its own Session rather than to this Workbench), and Close. `idBase` names the tabs so
 * the panel below can point back at the active one.
 */
export function PortalHeader({
    activePath,
    idBase,
    isMaximized,
    panelId,
    paths,
    sessionId,
}: {
    activePath: string;
    idBase: string;
    isMaximized: boolean;
    panelId: string;
    paths: readonly string[];
    sessionId: string;
}) {
    const { t } = useTranslation();
    const hasChoices = paths.length > 1;
    const childSessionId = useTerminal(
        parseAgentDelegationTab(activePath)?.terminalId ?? '',
    )?.sessionId;
    const tabListReference = useRef<HTMLDivElement>(null);
    /**
     * Arrow keys select the neighbour and move focus with it (roving tabindex: only the active tab is in the Tab
     * order).
     */
    const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const next = nextPortalTabPath(paths, activePath, event.key);
        if (next === undefined) return;
        event.preventDefault();
        usePortalStore.getState().select(sessionId, next);
        // The tab only becomes selected on the next commit, so focus follows after it.
        requestAnimationFrame(() =>
            tabListReference.current
                ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
                ?.focus(),
        );
    };
    return (
        <div className="flex h-9 flex-none items-center gap-1 border-b border-border pr-1 pl-2">
            <div
                role={hasChoices ? 'tablist' : undefined}
                aria-label={t('agentChat.portal.tabs')}
                aria-orientation={hasChoices ? 'horizontal' : undefined}
                className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
                ref={tabListReference}
                onKeyDown={hasChoices ? onTabKeyDown : undefined}
            >
                {paths.map((path, index) => (
                    <PortalTab
                        key={path}
                        hasChoices={hasChoices}
                        isActive={path === activePath}
                        panelId={panelId}
                        path={path}
                        sessionId={sessionId}
                        tabId={portalTabId(idBase, index)}
                    />
                ))}
            </div>
            {childSessionId ? (
                <Tooltip content={t('agentChat.portal.openSession')}>
                    <Button
                        aria-label={t('agentChat.portal.openSession')}
                        size="icon"
                        variant="ghost"
                        onClick={() => {
                            usePortalStore.getState().close(sessionId, activePath);
                            openSession(childSessionId);
                        }}
                    >
                        <SquareArrowOutUpRight aria-hidden="true" size={14} />
                    </Button>
                </Tooltip>
            ) : (
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
            )}
            <Tooltip
                content={t(isMaximized ? 'agentChat.portal.restore' : 'agentChat.portal.maximize')}
                shortcut={isMaximized ? 'escape' : undefined}
            >
                <Button
                    aria-label={t(
                        isMaximized ? 'agentChat.portal.restore' : 'agentChat.portal.maximize',
                    )}
                    aria-pressed={isMaximized}
                    size="icon"
                    variant="ghost"
                    onClick={() => usePortalStore.getState().toggleMaximized(sessionId)}
                >
                    {isMaximized ? (
                        <Minimize2 aria-hidden="true" size={14} />
                    ) : (
                        <Maximize2 aria-hidden="true" size={14} />
                    )}
                </Button>
            </Tooltip>
            <Tooltip
                content={t('agentChat.portal.close')}
                shortcut={isMaximized ? undefined : 'escape'}
            >
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
 * One item in the Side View header. A lone item is a plain title: there is nothing to switch to, so it draws no
 * selection and no close button of its own (the header's X closes it). Two or more become tabs.
 */
function PortalTab({
    hasChoices,
    isActive,
    panelId,
    path,
    sessionId,
    tabId,
}: {
    hasChoices: boolean;
    isActive: boolean;
    panelId: string;
    path: string;
    sessionId: string;
    tabId: string;
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
                id={tabId}
                aria-controls={isActive ? panelId : undefined}
                aria-selected={isActive}
                className="flex min-w-0 items-center gap-1.5 rounded-md py-1 pl-2 outline-none focus-visible:outline focus-visible:outline-accent"
                tabIndex={isActive ? 0 : -1}
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
