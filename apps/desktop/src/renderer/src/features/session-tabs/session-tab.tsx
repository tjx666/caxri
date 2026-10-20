import type { KeyboardEvent, MouseEvent } from 'react';

import { X } from 'lucide-react';

import { ContextMenuTrigger } from '../../components/context-menu-trigger';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import type { ContextMenuEntries } from '../../lib/context-menu';
import { cn } from '../../lib/utilities';
import { useSessionById } from '../../stores/selectors';
import { useWorkbenchStore } from '../../stores/workbench';
import { SessionStatusIndicator } from '../primary-sidebar/session-status-indicator';
import { sessionAgentTerminal } from '../session/session-agent-terminal';
import { sessionTitleForDisplay } from '../session/session-title';
import type { WorkTabNavigationKey } from '../tabs/work-tab-accessibility';
import { activateSessionTab, closeSessionTabs } from './session-tab-commands';
import { sessionTabDomId } from './session-tab-dom-id';
import { sessionTabMenu } from './session-tab-menu';

function isNavigationKey(key: string): key is WorkTabNavigationKey {
    return ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key);
}

/**
 * One Open Session. Everything it shows comes from selectors scoped to its own Session ID: the Session record, its
 * Project's title (a string, so the Project record's `lastOpenedAt` churn never reaches it), whether it is the selected
 * Session (a boolean), and its Agent Terminal. Switching or reordering tabs therefore re-renders the tabs that changed,
 * never every tab, and no Workbench subscribes to any of it.
 *
 * Visual language follows a pane tab (`WorkTab`): the same `--tab-*` fills, the 2px accent on the active tab, the close
 * button revealed on hover and focus (always on the active tab), and the hairline between tabs.
 */
export function SessionTab({
    count,
    index,
    onKeyboardNavigate,
    onShift,
    sessionId,
}: {
    count: number;
    index: number;
    onKeyboardNavigate: (sessionId: string, key: WorkTabNavigationKey) => void;
    onShift: (sessionId: string, direction: -1 | 1) => void;
    sessionId: string;
}) {
    const { t } = useTranslation();
    const session = useSessionById(sessionId);
    const isActive = useWorkbenchStore((state) => state.bootstrap?.selectedSessionId === sessionId);
    const projectTitle = useWorkbenchStore((state) =>
        session
            ? state.bootstrap?.projects.find((project) => project.id === session.projectId)
                  ?.displayTitle
            : undefined,
    );
    const terminal = useWorkbenchStore((state) =>
        session ? sessionAgentTerminal(session, state.bootstrap?.terminals ?? []) : undefined,
    );
    // Pruned from the snapshot a moment before the strip catches up.
    if (!session) return null;
    const title = sessionTitleForDisplay(session.displayTitle, t);
    const tooltip = projectTitle
        ? t('sessionTabs.tooltip', { title, project: projectTitle })
        : title;
    const closeLabel = t('sessionTabs.closeNamed', { title });
    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
        if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
            event.preventDefault();
            onShift(sessionId, event.key === 'ArrowLeft' ? -1 : 1);
            return;
        }
        if (isNavigationKey(event.key)) {
            event.preventDefault();
            onKeyboardNavigate(sessionId, event.key);
        }
    };
    return (
        <ContextMenuTrigger menu={(): ContextMenuEntries => sessionTabMenu(sessionId)}>
            <div
                className={cn(
                    'session-tab group relative flex h-full min-w-32 flex-1 basis-0 items-center border-r border-border bg-tab-inactive-background pr-1.5 text-tab-inactive-foreground [-webkit-app-region:no-drag] hover:bg-tab-hover-background hover:text-tab-hover-foreground',
                    'max-w-56',
                    isActive &&
                        "active bg-tab-active-background text-tab-active-foreground before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-accent before:content-['']",
                )}
                data-session-tab-id={sessionId}
                data-tab-active={isActive || undefined}
                draggable
                // Middle-click closes, matching pane tabs and every browser; the mousedown guard stops the platform's
                // autoscroll cursor from taking the click first.
                onMouseDown={(event: MouseEvent) => {
                    if (event.button === 1) event.preventDefault();
                }}
                onAuxClick={(event: MouseEvent) => {
                    if (event.button !== 1) {
                        return;
                    }

                    event.preventDefault();
                    // Fire-and-forget: closing toasts its own failure.
                    // eslint-disable-next-line no-void -- intentional floating-promise discard
                    void closeSessionTabs(sessionId);
                }}
            >
                <Tooltip content={tooltip} hoverOnly triggerId={sessionTabDomId(sessionId)}>
                    <button
                        type="button"
                        role="tab"
                        aria-posinset={index + 1}
                        aria-selected={isActive}
                        aria-setsize={count}
                        aria-keyshortcuts={index < 9 ? `Meta+${index + 1}` : undefined}
                        tabIndex={isActive ? 0 : -1}
                        className="tab-select flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent px-2 text-left text-[11px] text-inherit focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-foreground"
                        onClick={() => activateSessionTab(sessionId)}
                        onKeyDown={onKeyDown}
                    >
                        <AgentIdentityIcon identity={terminal?.kind ?? 'shell'} size={13} />
                        <span className="tab-label min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                            {title}
                        </span>
                        <SessionStatusIndicator session={session} terminal={terminal} />
                    </button>
                </Tooltip>
                <Tooltip content={closeLabel}>
                    <button
                        type="button"
                        aria-label={closeLabel}
                        tabIndex={-1}
                        className={cn(
                            'tab-close grid h-5 w-5 flex-none cursor-pointer place-items-center rounded border-0 bg-transparent p-0 hover:bg-[var(--selection)] hover:text-foreground',
                            // VS Code's rule, as on pane tabs: the active tab always offers its close button, an
                            // inactive one reveals it under the pointer or keyboard focus.
                            'pointer-events-none text-muted opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100',
                            isActive && 'pointer-events-auto text-inherit opacity-100',
                        )}
                        onClick={() => {
                            // Fire-and-forget: closing toasts its own failure.
                            // eslint-disable-next-line no-void -- intentional floating-promise discard
                            void closeSessionTabs(sessionId);
                        }}
                    >
                        <X size={12} />
                    </button>
                </Tooltip>
            </div>
        </ContextMenuTrigger>
    );
}
