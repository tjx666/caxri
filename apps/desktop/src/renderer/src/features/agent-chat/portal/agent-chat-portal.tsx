import type { KeyboardEvent } from 'react';
import { useEffect, useId, useRef } from 'react';

import { AnimatePresence, domAnimation, LazyMotion } from 'motion/react';
import * as m from 'motion/react-m';

import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

import { SurfaceErrorBoundary } from '../../../components/surface-error-boundary';
import { useTranslation } from '../../../i18n';
import { isImeComposing } from '../../../lib/ime';
import { isEditableEventTarget } from '../../../lib/keybindings';
import { motionDurationMs, motionEasing } from '../../../lib/motion';
import { cn } from '../../../lib/utilities';
import {
    isPrimarySidebarShown,
    PORTAL_DEFAULT_WIDTH,
    PORTAL_MAX_WIDTH,
    PORTAL_MIN_WIDTH,
    useChromeLayoutStore,
} from '../../../stores/chrome-layout';
import { useDialogStore } from '../../../stores/dialogs';
import {
    useProjects,
    useSelectedSessionId,
    useSessions,
    useTerminals,
} from '../../../stores/selectors';
import { EditorSurface } from '../../editor/editor-surface';
import { PaneViewSessionProvider } from '../../workbench/pane-view-session';
import { PanelDivider } from '../../workbench/panel-divider';
import { besideChatTabTerminalId } from '../tasks/beside-chat-layout';
import { PortalHeader } from './portal-header';
import { portalTabId, shouldFocusPortalOnOpen } from './portal-keys';
import { portalSessionDeletion } from './portal-persistence';
import { useIsPortalMaximized, usePortalItems, usePortalStore } from './portal-store';

/**
 * Stands in for a pane id: the beside-Chat surfaces `EditorSurface` renders here never read it.
 */
const PORTAL_SURFACE_PANE_ID = 'agent-chat-portal';

/**
 * The Portal (the user sees it as "Side View"): a flyout over the window's right edge that shows a Chat's subagent and
 * background shell tasks, turn reviews, Context breakdown, and side chat without splitting the Workbench (issue #2370).
 * It covers the SecondarySidebar when that is on screen, and the Chat's right edge otherwise, so opening one never
 * reflows the Chat.
 *
 * Clicking back into the Chat leaves it open, so the user can read a subagent while typing to the main Agent. Escape
 * inside it, its X, or "Open in Split" (which turns the item into an ordinary pane tab) closes it.
 *
 * It slides and fades in and out on the overlay tokens (reduced motion skips both), and opening it from the keyboard
 * moves focus to its active tab so the user lands inside what they opened.
 */
export function AgentChatPortal() {
    const sessionId = useSelectedSessionId();
    const isPrimarySidebarVisible = useChromeLayoutStore(isPrimarySidebarShown);
    const isSettingsPageOpen = useDialogStore((state) => state.settingsPageOpen);
    const items = usePortalItems(sessionId);
    const isMaximized = useIsPortalMaximized(sessionId);
    const width = useChromeLayoutStore((state) => state.portalWidth);
    useEffect(() => {
        document.documentElement.style.setProperty('--agent-chat-portal-width', `${width}px`);
    }, [width]);
    useRetainLivePortalItems(sessionId);
    const { activePath } = items;
    const { t } = useTranslation();
    const idBase = useId();
    const panelId = `${idBase}-panel`;
    const portalReference = useRef<HTMLElement>(null);
    const shouldReduceMotion = useShouldReduceMotion();
    const isOpen = Boolean(sessionId && activePath && !isSettingsPageOpen);
    // A keyboard-opened (or keyboard-replaced) item takes focus into the Side View; a pointer open leaves it alone.
    useEffect(() => {
        const portal = portalReference.current;
        if (!isOpen || !portal) return;
        const trigger = document.activeElement;
        if (
            !shouldFocusPortalOnOpen({
                isEditable: isEditableEventTarget(trigger),
                isFocusVisible: Boolean(trigger?.matches(':focus-visible')),
                isInsidePortal: Boolean(trigger && portal.contains(trigger)),
            })
        )
            return;
        (portal.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? portal).focus();
    }, [isOpen, activePath]);
    const enter = shouldReduceMotion
        ? { duration: 0 }
        : {
              duration: motionDurationMs('--motion-overlay-enter') / 1000,
              ease: motionEasing('--motion-ease-enter'),
          };
    const exit = shouldReduceMotion
        ? { duration: 0 }
        : {
              duration: motionDurationMs('--motion-overlay-exit') / 1000,
              ease: motionEasing('--motion-ease-exit'),
          };
    const closeOnEscape = (event: KeyboardEvent<HTMLElement>): void => {
        // A key the content already handled (a menu's or picker's own Escape) is not a request to close.
        if (event.key !== 'Escape' || event.defaultPrevented || isImeComposing(event)) return;
        event.preventDefault();
        if (!sessionId) return;
        // Escape first restores a maximized Portal (bringing the Chat back); a second one closes it.
        if (isMaximized) usePortalStore.getState().restore(sessionId);
        else usePortalStore.getState().closeAll(sessionId);
    };
    const hasChoices = items.paths.length > 1;
    return (
        <LazyMotion strict features={domAnimation}>
            <AnimatePresence initial={false}>
                {isOpen && sessionId && activePath && (
                    <m.aside
                        key="portal"
                        animate={{ opacity: 1, x: 0, transition: enter }}
                        aria-label={t('agentChat.portal.label')}
                        data-agent-chat-portal=""
                        exit={{ opacity: 0, x: 12, transition: exit }}
                        initial={{ opacity: 0, x: 12 }}
                        ref={portalReference}
                        tabIndex={-1}
                        className={cn(
                            'agent-chat-portal absolute top-0 right-0 bottom-0 z-20 flex outline-none',
                            'min-w-0',
                            isMaximized
                                ? 'w-full'
                                : 'w-(--agent-chat-portal-width,480px) max-w-[calc(100%-320px)]',
                            'border-l border-border bg-surface shadow-[0_8px_24px_var(--shadow)]',
                            // Settings covers the same grid area and hides the Portal; see `SettingsPageHost` in `app.tsx`.
                            '[grid-row:1/2]',
                            isPrimarySidebarVisible ? '[grid-column:3/-1]' : '[grid-column:1/-1]',
                        )}
                        onKeyDown={closeOnEscape}
                    >
                        <PaneViewSessionProvider value={sessionId}>
                            {!isMaximized && <PortalResizeEdge width={width} />}
                            <div className="flex min-w-0 flex-1 flex-col">
                                <PortalHeader
                                    activePath={activePath}
                                    idBase={idBase}
                                    isMaximized={isMaximized}
                                    panelId={panelId}
                                    paths={items.paths}
                                    sessionId={sessionId}
                                />
                                <div
                                    aria-labelledby={
                                        hasChoices
                                            ? portalTabId(idBase, items.paths.indexOf(activePath))
                                            : undefined
                                    }
                                    className="relative min-h-0 flex-1"
                                    id={panelId}
                                    role={hasChoices ? 'tabpanel' : undefined}
                                >
                                    {/* Items restore after a reload, but a faulting surface only resets on its own path, so a local boundary suffices. */}
                                    <SurfaceErrorBoundary resetKey={activePath} scope="portal">
                                        <EditorSurface
                                            key={activePath}
                                            paneId={PORTAL_SURFACE_PANE_ID}
                                            path={activePath}
                                        />
                                    </SurfaceErrorBoundary>
                                </div>
                            </div>
                        </PaneViewSessionProvider>
                    </m.aside>
                )}
            </AnimatePresence>
        </LazyMotion>
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

/**
 * Drops Portal items whose Chat is gone, so closing a Chat never leaves its subagent floating over another one, and
 * forgets the items of deleted Sessions (only those of machines this window lists; see `portalSessionDeletion`).
 */
function useRetainLivePortalItems(sessionId: string | undefined): void {
    const terminals = useTerminals();
    const sessions = useSessions();
    const projects = useProjects();
    // Items restored from the last run name Chats the workbench snapshot has not delivered yet; judging them against
    // an empty Terminal list would drop every one, so retention waits for the snapshot.
    useEffect(() => {
        if (!sessions || !projects) return;
        usePortalStore.getState().pruneSessions(portalSessionDeletion({ projects, sessions }));
    }, [projects, sessions]);
    useEffect(() => {
        if (!sessionId || !sessions) return;
        const live = new Set(terminals.map((terminal) => terminal.id));
        usePortalStore.getState().retain(sessionId, (path) => {
            const terminalId = besideChatTabTerminalId(path);
            return terminalId !== undefined && live.has(terminalId);
        });
    }, [sessionId, sessions, terminals]);
}
