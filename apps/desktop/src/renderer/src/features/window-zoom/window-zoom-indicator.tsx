import { useEffect, useState } from 'react';

import { ZoomIn, ZoomOut } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useSettings } from '../../stores/selectors';
import { windowZoomIndicator, windowZoomPercent } from './window-zoom-commands';
import { WindowZoomControls } from './window-zoom-controls';

/**
 * A standing reminder that the window is zoomed, the way Chrome puts a magnifier in the address bar and VS Code a zoom
 * entry in its status bar while the zoom differs from the default: the transient HUD says what changed, this keeps
 * saying it. It shows the percentage only while `window.zoomLevel` is not 0, and clicking it opens the same Zoom Out,
 * Zoom In, and Reset row; Reset returns to 100% and so removes the indicator. `triggerClassName` fits it to the bar it
 * sits in, and `side` opens the row away from that bar.
 */
export function WindowZoomIndicator({
    side,
    triggerClassName,
}: {
    side: 'bottom' | 'top';
    triggerClassName: string;
}) {
    const { t } = useTranslation();
    const level = useSettings()?.['window.zoomLevel'] ?? 0;
    const [isOpen, setOpen] = useState(false);
    // Reset (or a shortcut) back to 100% removes the indicator, so its popover closes with it instead of lingering on
    // "100%" with every button disabled. Adjusting state during render drops the stale open flag before it can reopen
    // the popover at the next zoom change.
    if (level === 0 && isOpen) setOpen(false);
    useEffect(() => {
        // The HUD reads this shared flag, so it must follow the popover's real state.
        if (level === 0) windowZoomIndicator.isOpen = false;
    }, [level]);
    if (level === 0) return null;
    const percent = windowZoomPercent(level);
    const label = t('windowZoom.indicator.label', { percent });
    return (
        <Popover
            open={isOpen}
            onOpenChange={(open) => {
                windowZoomIndicator.isOpen = open;
                setOpen(open);
            }}
        >
            <Tooltip content={t('windowZoom.indicator.tooltip', { percent })} disabled={isOpen}>
                <PopoverTrigger
                    aria-label={label}
                    className={cn(triggerClassName, 'window-zoom-indicator')}
                >
                    {level < 0 ? (
                        <ZoomOut aria-hidden="true" size={13} />
                    ) : (
                        <ZoomIn aria-hidden="true" size={13} />
                    )}
                    <span className="tabular-nums">{percent}%</span>
                </PopoverTrigger>
            </Tooltip>
            <PopoverContent
                align="end"
                aria-label={t('windowZoom.hud.label')}
                className="flex w-auto items-center gap-0.5 py-1 pr-1 pl-3"
                side={side}
            >
                <WindowZoomControls level={level} />
            </PopoverContent>
        </Popover>
    );
}
