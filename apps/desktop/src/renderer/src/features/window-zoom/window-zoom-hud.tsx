import type { FocusEvent, ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';

import { Minus, Plus } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useSettings } from '../../stores/selectors';
import type { WindowZoomStep } from './window-zoom-commands';
import { stepWindowZoom, WINDOW_ZOOM_BOUNDS, windowZoomPercent } from './window-zoom-commands';

/**
 * How long the HUD stays after the last zoom change while nothing holds it.
 */
const HUD_VISIBLE_MS = 1500;

function HudIconButton({
    disabled,
    icon,
    label,
    step,
}: {
    disabled: boolean;
    icon: ReactElement;
    label: string;
    step: WindowZoomStep;
}) {
    return (
        <Tooltip content={label}>
            <Button
                aria-label={label}
                disabled={disabled}
                size="icon"
                variant="ghost"
                onClick={() => stepWindowZoom(step)}
            >
                {icon}
            </Button>
        </Tooltip>
    );
}

/**
 * The zoom HUD, as the ChatGPT desktop app shows one: after any change to `window.zoomLevel` (a shortcut, the View
 * menu, the command palette, or Settings) the current percentage appears at the window's top right with Zoom Out, Zoom
 * In, and Reset beside it, then fades away. Hovering it, or tabbing into it, keeps it up so the buttons can be used;
 * the first settings load shows nothing, since no zoom changed. Mounted by every window that follows the app zoom.
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
        if (!wasLoaded) return;
        setShown(true);
        scheduleHide();
        // scheduleHide only reads refs and the stable setter.
    }, [level]);
    useEffect(() => () => clearTimeout(hideTimer.current), []);

    if (level === undefined) return null;
    const percent = windowZoomPercent(level);
    const release = (hold: 'isHovered' | 'isFocused'): void => {
        holds.current[hold] = false;
        scheduleHide();
    };
    return (
        <div
            aria-label={t('windowZoom.hud.label')}
            className={cn(
                'fixed top-13 right-3 z-[90] flex items-center gap-0.5 rounded-md bg-elevated py-1 pr-1 pl-3 text-[12px] text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)]',
                'transition-[opacity,translate] duration-(--motion-overlay-enter) ease-(--motion-ease-enter) motion-reduce:transition-none',
                isShown
                    ? 'translate-y-0 opacity-100'
                    : 'pointer-events-none -translate-y-1 opacity-0',
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
            <span
                aria-label={t('windowZoom.hud.percent', { percent })}
                aria-live="polite"
                className="mr-1 min-w-10 text-center font-medium tabular-nums"
                role="status"
            >
                {percent}%
            </span>
            <HudIconButton
                disabled={level <= WINDOW_ZOOM_BOUNDS.min}
                icon={<Minus aria-hidden="true" size={14} />}
                label={t('windowZoom.hud.zoomOut')}
                step="out"
            />
            <HudIconButton
                disabled={level >= WINDOW_ZOOM_BOUNDS.max}
                icon={<Plus aria-hidden="true" size={14} />}
                label={t('windowZoom.hud.zoomIn')}
                step="in"
            />
            <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
            <Button
                disabled={level === 0}
                size="sm"
                variant="ghost"
                onClick={() => stepWindowZoom('reset')}
            >
                {t('windowZoom.hud.reset')}
            </Button>
        </div>
    );
}
