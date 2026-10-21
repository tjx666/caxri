import type { KeyboardEvent, MouseEvent } from 'react';

import { X } from 'lucide-react';

import { ContextMenuTrigger } from '../../components/context-menu-trigger';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import type { ContextMenuEntries } from '../../lib/context-menu';
import { cn } from '../../lib/utilities';
import { useIsPreviewSession } from '../../stores/open-sessions';
import { useSessionById } from '../../stores/selectors';
import { useWorkbenchStore } from '../../stores/workbench';
import { sessionWorktreeProject } from '../primary-sidebar/project-visibility';
import { currentSessionActivityPresentation } from '../primary-sidebar/session-activity';
import { SessionStatusIndicator } from '../primary-sidebar/session-status-indicator';
import { useSessionLabel } from '../session/hooks/use-session-label';
import { sessionAgentTerminal } from '../session/session-agent-terminal';
import type { WorkTabNavigationKey } from '../tabs/work-tab-accessibility';
import {
    clearLinkedHoveredSession,
    setLinkedHoveredSession,
    useIsLinkedSessionHovered,
} from './linked-session-hover';
import { activateSessionTab, closeSessionTabs, keepSessionTab } from './session-tab-commands';
import { sessionTabDomId } from './session-tab-dom-id';
import { sessionTabMenu } from './session-tab-menu';
import { sessionTabTooltip } from './session-tab-tooltip';
import { sessionTabShortcutKey } from './session-tabs-state';

/**
 * The status glyph on a Session tab, one step louder than in the sidebar: the pill sits on the title-bar fill with no
 * row of its own, so the sidebar's `--muted` running ring nearly vanishes on an inactive tab. A running or detached
 * glyph takes a 70% or 60% foreground, and an attention glyph gets a faint warning disc behind its ring. The variants
 * are keyed on the status class so the attention glyph keeps `--warning`.
 */
const SESSION_TAB_STATUS_CLASS =
    '[&.session-status-running]:text-foreground/70 [&.session-status-detached]:text-foreground/60 [&.session-status-attention]:rounded-full [&.session-status-attention]:bg-warning/15';

function isNavigationKey(key: string): key is WorkTabNavigationKey {
    return ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key);
}

/**
 * The title and the muted disambiguation suffix of a tab. The Preview entry is set in italic (and muted while inactive)
 * so the tab a plain click will replace is recognizable before the click.
 */
function SessionTabLabel({
    isActive,
    isPreview,
    suffix,
    title,
}: {
    isActive: boolean;
    isPreview: boolean;
    suffix: string | undefined;
    title: string;
}) {
    return (
        <span
            className={cn(
                'tab-label min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap',
                isPreview && 'italic',
                isPreview && !isActive && 'text-muted group-hover:text-foreground',
            )}
        >
            {title}
            {suffix && (
                <span className="tab-detail ml-1.5 text-[11px] font-normal text-muted">
                    {suffix}
                </span>
            )}
        </span>
    );
}

/**
 * One Open Session. Everything it shows comes from selectors scoped to its own Session ID: the Session record, its
 * Project's title (a string, so the Project record's `lastOpenedAt` churn never reaches it), whether it is the selected
 * Session (a boolean), and its Agent Terminal. Switching or reordering tabs therefore re-renders the tabs that changed,
 * never every tab, and no Workbench subscribes to any of it.
 *
 * Session level of DESIGN.md's "Two tab levels": an inset neutral pill (raised fill when active, a quiet hover fill
 * otherwise, short dividers between idle neighbours) and the close button revealed on hover and focus (always on the
 * active tab). It carries no accent; that stays with the focused pane's active tab below.
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
    const workingLocation = useWorkbenchStore((state) =>
        session
            ? sessionWorktreeProject(session, state.bootstrap?.projects ?? [])?.displayTitle
            : undefined,
    );
    const label = useSessionLabel(sessionId);
    // The Preview entry: the one tab a plain sidebar click replaces. Italic, like VS Code's preview editor.
    const isPreview = useIsPreviewSession(sessionId);
    // The pointer is over this Session's sidebar row; see `linked-session-hover.ts`.
    const isLinkedHover = useIsLinkedSessionHovered(sessionId);
    // Pruned from the snapshot a moment before the strip catches up.
    if (!session) return null;
    const { title } = label;
    const tooltip = sessionTabTooltip(
        {
            agentLabel: resolveAgentIcon(terminal?.kind ?? 'shell').label,
            projectTitle,
            shortcutDigit: sessionTabShortcutKey(index, count)?.replace('Meta+', ''),
            statusLabel: currentSessionActivityPresentation(session, terminal).label,
            suffix: label.suffix,
            title,
            workingLocation,
        },
        t,
    );
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
                    // An inset pill on the strip's title-bar fill. Selection is a neutral raised fill, never the accent:
                    // the accent belongs to the focused pane's active tab (DESIGN.md "Two tab levels"). Widths:
                    // 104px floor so five or six fit a 1280px window, 200px cap, and the active tab keeps 150px so
                    // its title stays readable however crowded the strip gets.
                    'session-tab group relative flex h-7 max-w-50 min-w-26 flex-1 basis-0 items-center rounded-md pr-1 text-[11px] font-medium text-tab-inactive-foreground [-webkit-app-region:no-drag] hover:bg-elevated/60 hover:text-foreground',
                    // The short divider after this tab. It hides beside the active tab, beside a hovered tab, and at
                    // the end of the row, so a pill never sits flush against a line.
                    "after:pointer-events-none after:absolute after:top-1.5 after:-right-[2.5px] after:h-4 after:w-px after:bg-border after:content-[''] hover:after:opacity-0 has-[+.session-tab-new]:after:hidden has-[+.session-tab:hover]:after:opacity-0 has-[+[data-tab-active]]:after:opacity-0",
                    // Soft echo of a hover on the Session's sidebar row, the same fill as this tab's own hover.
                    isLinkedHover && !isActive && 'bg-elevated/60 text-foreground',
                    isActive &&
                        'active min-w-37.5 bg-elevated text-foreground shadow-sm after:opacity-0 hover:bg-elevated',
                )}
                data-session-tab-id={sessionId}
                data-tab-active={isActive || undefined}
                data-tab-preview={isPreview || undefined}
                draggable
                onPointerEnter={() => setLinkedHoveredSession(sessionId)}
                onPointerLeave={() => clearLinkedHoveredSession(sessionId)}
            >
                <Tooltip content={tooltip} hoverOnly triggerId={sessionTabDomId(sessionId)}>
                    <button
                        type="button"
                        role="tab"
                        aria-posinset={index + 1}
                        aria-selected={isActive}
                        aria-setsize={count}
                        aria-keyshortcuts={sessionTabShortcutKey(index, count)}
                        tabIndex={isActive ? 0 : -1}
                        className="tab-select flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-[11px] text-inherit focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-foreground"
                        onClick={() => activateSessionTab(sessionId)}
                        // Double-click keeps a Preview tab, the same gesture as VS Code's preview editor.
                        onDoubleClick={() => {
                            // Fire-and-forget: keeping toasts its own failure.
                            // eslint-disable-next-line no-void -- intentional floating-promise discard
                            void keepSessionTab(sessionId);
                        }}
                        onKeyDown={onKeyDown}
                        // Middle-click closes, matching pane tabs and every browser; the mousedown guard stops the
                        // platform's autoscroll cursor from taking the click first.
                        onMouseDown={(event: MouseEvent) => {
                            if (event.button === 1) event.preventDefault();
                        }}
                        onAuxClick={(event: MouseEvent) => {
                            if (event.button !== 1) return;
                            event.preventDefault();
                            // Fire-and-forget: closing toasts its own failure.
                            // eslint-disable-next-line no-void -- intentional floating-promise discard
                            void closeSessionTabs(sessionId);
                        }}
                    >
                        <AgentIdentityIcon identity={terminal?.kind ?? 'shell'} size={13} />
                        <SessionTabLabel
                            isActive={isActive}
                            isPreview={isPreview}
                            suffix={label.suffix}
                            title={title}
                        />
                        {isPreview && (
                            <span className="sr-only">{t('sessionTabs.previewHint')}</span>
                        )}
                    </button>
                </Tooltip>
                {/* One fixed 20px slot shared by the status glyph and the close button, so the title never shifts
                    when one hands over to the other. The glyph fades out as the close button fades in under the
                    pointer or keyboard focus; the active tab always shows the close button (VS Code's rule, as on
                    pane tabs) and so never shows its glyph, which the sidebar row and the tooltip still carry. */}
                <span className="session-tab-trailing relative size-5 flex-none">
                    <span
                        className={cn(
                            'absolute inset-0 grid place-items-center transition-opacity duration-100 group-focus-within:opacity-0 group-hover:opacity-0',
                            isActive && 'opacity-0',
                        )}
                    >
                        <SessionStatusIndicator
                            session={session}
                            terminal={terminal}
                            className={SESSION_TAB_STATUS_CLASS}
                        />
                    </span>
                    <Tooltip content={closeLabel}>
                        <button
                            type="button"
                            aria-label={closeLabel}
                            tabIndex={-1}
                            className={cn(
                                'tab-close absolute inset-0 grid cursor-pointer place-items-center rounded border-0 bg-transparent p-0 hover:bg-[var(--selection)] hover:text-foreground',
                                'pointer-events-none text-muted opacity-0 transition-opacity duration-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100',
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
                </span>
            </div>
        </ContextMenuTrigger>
    );
}
