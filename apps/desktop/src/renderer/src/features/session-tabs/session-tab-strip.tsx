import { useRef, useState } from 'react';

import { ScrollFade } from '../../components/scroll-fade';
import { useScrollEdges } from '../../hooks/use-scroll-edges';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useChromeLayoutStore } from '../../stores/chrome-layout';
import { useIsSessionTabStripVisible, useOpenSessionIds } from '../../stores/open-sessions';
import { useIsFullScreen } from '../../stores/selectors';
import { useWorkbenchStore } from '../../stores/workbench';
import { sessionTitleForDisplay } from '../session/session-title';
import type { WorkTabNavigationKey } from '../tabs/work-tab-accessibility';
import { workTabNavigationTarget } from '../tabs/work-tab-accessibility';
import { useActiveTabReveal } from '../workbench/pane-tab-reveal';
import { SessionTab } from './session-tab';
import { activateSessionTab, shiftSessionTab } from './session-tab-commands';
import { sessionTabDomId } from './session-tab-dom-id';
import { SessionTabNewButton } from './session-tab-new-button';
import { useSessionTabDrag } from './use-session-tab-drag';

/**
 * The Open Session strip: one tab per Session this window has open, above the Workbench. It exists only from two Open
 * Sessions on, and while it shows it is the window's title bar (drag region, traffic-light inset, title-bar fill),
 * which the Workbench's own pane tab bar stops being (see `PaneTabBar`).
 *
 * This outer component subscribes to nothing but a boolean, so a window with a single Open Session pays no cost.
 */
export function SessionTabStrip() {
    const isVisible = useIsSessionTabStripVisible();
    return isVisible ? <SessionTabStripBar /> : null;
}

function SessionTabStripBar() {
    const { t } = useTranslation();
    const openSessionIds = useOpenSessionIds();
    const activeSessionId = useWorkbenchStore((state) => state.bootstrap?.selectedSessionId);
    const isPrimarySidebarVisible = useChromeLayoutStore((state) => state.primarySidebarVisible);
    const isFullScreen = useIsFullScreen();
    const listReference = useRef<HTMLDivElement>(null);
    const scrollReference = useRef<HTMLDivElement>(null);
    const startSentinel = useRef<HTMLSpanElement>(null);
    const endSentinel = useRef<HTMLSpanElement>(null);
    const { canScrollEnd, canScrollStart } = useScrollEdges(
        scrollReference,
        startSentinel,
        endSentinel,
    );
    const { dropIndicatorLeft, onDragEnd, onDragLeave, onDragOver, onDragStart, onDrop } =
        useSessionTabDrag(listReference);
    const [announcement, setAnnouncement] = useState('');
    useActiveTabReveal(listReference, activeSessionId, dropIndicatorLeft !== undefined);

    const navigate = (fromSessionId: string, key: WorkTabNavigationKey): void => {
        const target = workTabNavigationTarget(openSessionIds, fromSessionId, key);
        if (!target) return;
        // Roving focus with automatic activation, like a pane's tab bar.
        document.querySelector<HTMLElement>(`#${CSS.escape(sessionTabDomId(target))}`)?.focus();
        activateSessionTab(target);
    };
    const shift = (sessionId: string, direction: -1 | 1): void => {
        // Fire-and-forget: the reorder toasts its own failure.
        // eslint-disable-next-line no-void -- intentional floating-promise discard
        void shiftSessionTab(sessionId, direction).then(() => {
            const position = openSessionIds.indexOf(sessionId) + direction;
            const session = useWorkbenchStore
                .getState()
                .bootstrap?.sessions.find((item) => item.id === sessionId);
            if (!session || position < 0 || position >= openSessionIds.length) return;
            setAnnouncement(
                t('sessionTabs.reordered', {
                    title: sessionTitleForDisplay(session.displayTitle, t),
                    position: position + 1,
                    count: openSessionIds.length,
                }),
            );
        });
    };
    return (
        <div
            className={cn(
                // The frameless window's title bar while the strip shows: 36px like the sidebar rails and the pane row
                // below it, so the traffic lights stay centered in it and the rails keep one bottom edge. The 1px
                // hairline to the pane row is an inset shadow, not a border, so it does not eat into that height.
                'session-tab-strip flex h-9 flex-none bg-title-bar-active-background text-title-bar-active-foreground shadow-[inset_0_-1px_0_var(--border)] [-webkit-app-region:drag] window-inactive:bg-title-bar-inactive-background window-inactive:text-title-bar-inactive-foreground',
                !isPrimarySidebarVisible && !isFullScreen && 'pl-(--traffic-light-clearance)',
            )}
            data-session-tab-strip=""
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
        >
            <div
                ref={listReference}
                role="tablist"
                aria-label={t('sessionTabs.listLabel')}
                aria-orientation="horizontal"
                className="relative flex min-w-0 flex-1"
            >
                {dropIndicatorLeft !== undefined && (
                    <div
                        aria-hidden="true"
                        className="session-tab-drop-marker pointer-events-none absolute top-1.5 bottom-1.5 z-10 w-0.5 bg-accent"
                        style={{ left: dropIndicatorLeft }}
                    >
                        <span className="absolute -top-0.5 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-accent" />
                    </div>
                )}
                <div
                    ref={scrollReference}
                    // Read by `useActiveTabReveal` to measure the active tab against the rail that scrolls.
                    data-tab-scroll-rail=""
                    className="work-tab-scroll relative flex min-w-0 flex-1 overflow-x-auto"
                >
                    <div role="none" className="flex h-9 min-w-full items-center gap-1 px-1">
                        <span
                            ref={startSentinel}
                            aria-hidden="true"
                            className="w-px flex-none self-stretch"
                        />
                        {openSessionIds.map((sessionId, index) => (
                            <SessionTab
                                key={sessionId}
                                count={openSessionIds.length}
                                index={index}
                                sessionId={sessionId}
                                onKeyboardNavigate={navigate}
                                onShift={shift}
                            />
                        ))}
                        <SessionTabNewButton />
                        <span
                            ref={endSentinel}
                            aria-hidden="true"
                            className="w-px flex-none self-stretch"
                        />
                    </div>
                </div>
                {canScrollStart && <ScrollFade edge="start" fill="titleBar" />}
                {canScrollEnd && <ScrollFade edge="end" fill="titleBar" />}
            </div>
            <span role="status" aria-live="polite" className="sr-only">
                {announcement}
            </span>
            {/* Tabs stop at a maximum width, so a window with few of them keeps free title bar to drag; this corner
                covers the case where they fill the bar and the primarySidebar is hidden, as in `PaneTabBar`. */}
            {!isPrimarySidebarVisible && (
                <div
                    aria-hidden="true"
                    className="session-tab-strip-drag-handle h-9 w-8 flex-none"
                />
            )}
        </div>
    );
}
