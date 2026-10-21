import type { FocusEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useSettings } from '../../stores/selectors';
import { windowZoomIndicator, windowZoomPercent } from './window-zoom-commands';
import { WindowZoomControls } from './window-zoom-controls';

/**
 * How long the HUD stays after the last zoom change while nothing holds it.
 */
const HUD_VISIBLE_MS = 1500;

/**
 * The zoom HUD, as the ChatGPT desktop app shows one: after any change to `window.zoomLevel` (a shortcut, the View
 * menu, the command palette, or Settings) the current percentage appears at the window's bottom right, just above the
 * status bar where the persistent zoom indicator lives, with Zoom Out, Zoom In, and Reset beside it, then fades away.
 * Hovering it, or tabbing into it, keeps it up so the buttons can be used; the first settings load shows nothing, since
 * no zoom changed. It sits at the bottom right rather than the top right because the top right is chrome (the secondary
 * sidebar's title and action icons); the bottom-right corner above the status bar covers only the end of the content
 * area for the 1.5 seconds it is up. Mounted by every window that follows the app zoom.
 */
export function WindowZoomHud() {
    const { t } = useTranslation();
    const level = useSettings()?.['window.zoomLevel'];
    const [isShown, setShown] = useState(false);
    const previousLevel = useRef(level);
    const hideTimer = useRef<number | undefined>(undefined);
    /**
     * The pointer is over the HUD or keyboard focus is inside it. A pointer click also focuses its button, so only
     * `:focus-visible` focus holds the HUD; otherwise a clicked button would keep it up after the pointer left.
     */
    const holds = useRef({ isHovered: false, isFocused: false });

    const scheduleHide = (): void => {
        clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => {
            if (!holds.current.isHovered && !holds.current.isFocused) setShown(false);
        }, HUD_VISIBLE_MS);
    };

    useEffect(() => {
        if (previousLevel.current === level) return;
        const wasLoaded = previousLevel.current !== undefined;
        previousLevel.current = level;
        if (!wasLoaded || windowZoomIndicator.isOpen) return;
        setShown(true);
        scheduleHide();
        // scheduleHide only reads refs and the stable setter.
    }, [level]);
    useEffect(() => () => clearTimeout(hideTimer.current), []);

    if (level === undefined) return null;
    const release = (hold: 'isHovered' | 'isFocused'): void => {
        holds.current[hold] = false;
        scheduleHide();
    };
    return (
        <>
            {/*
             * The announcement lives outside the HUD's `inert` subtree: an inert node is removed from the accessibility
             * tree, so a live region inside it never speaks. It is filled only while the HUD is shown, so a change
             * made while hidden stays silent until the next zoom step.
             */}
            <div aria-live="polite" className="sr-only" role="status">
                {isShown ? t('windowZoom.hud.percent', { percent: windowZoomPercent(level) }) : ''}
            </div>
            <div
                aria-label={t('windowZoom.hud.label')}
                className={cn(
                    'fixed right-3 bottom-9 z-[90] flex items-center gap-0.5 rounded-md bg-elevated py-1 pr-1 pl-3 text-[12px] text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)]',
                    'transition-[opacity,translate] duration-(--motion-overlay-enter) ease-(--motion-ease-enter) motion-reduce:transition-none',
                    isShown
                        ? 'translate-y-0 opacity-100'
                        : 'pointer-events-none translate-y-1 opacity-0',
                )}
                data-window-zoom-hud={isShown ? 'shown' : 'hidden'}
                inert={!isShown}
                role="toolbar"
                onBlur={(event: FocusEvent<HTMLDivElement>) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) release('isFocused');
                }}
                onFocus={(event: FocusEvent<HTMLDivElement>) => {
                    if (!event.target.matches(':focus-visible')) return;
                    holds.current.isFocused = true;
                    clearTimeout(hideTimer.current);
                }}
                onPointerEnter={() => {
                    holds.current.isHovered = true;
                    clearTimeout(hideTimer.current);
                }}
                onPointerLeave={() => release('isHovered')}
            >
                <WindowZoomControls isLive={false} level={level} />
            </div>
        </>
    );
}
