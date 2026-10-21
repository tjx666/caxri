import type { ReactElement } from 'react';

import type { CommandId } from '@caxri/protocol';
import { Minus, Plus } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { useCommandShortcut } from '../../lib/keybindings';
import type { WindowZoomStep } from './window-zoom-commands';
import { stepWindowZoom, WINDOW_ZOOM_BOUNDS, windowZoomPercent } from './window-zoom-commands';

function ZoomIconButton({
    commandId,
    disabled,
    icon,
    label,
    step,
}: {
    /**
     * The View command this button mirrors; its live keybinding is the tooltip's shortcut hint.
     */
    commandId: CommandId;
    disabled: boolean;
    icon: ReactElement;
    label: string;
    step: WindowZoomStep;
}) {
    const shortcut = useCommandShortcut(commandId);
    return (
        <Tooltip content={label} shortcut={shortcut}>
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
 * The current percentage with Zoom Out, Zoom In, and Reset beside it: the row the transient zoom HUD shows and the
 * persistent zoom indicator opens, so both read and act the same way.
 */
export function WindowZoomControls({
    isLive = true,
    level,
}: {
    /**
     * Whether the percentage is its own live region. The transient HUD turns it off because it is `inert` while hidden
     * and announces the percentage from a live region outside that subtree instead.
     */
    isLive?: boolean;
    level: number;
}) {
    const { t } = useTranslation();
    const resetShortcut = useCommandShortcut('view.resetZoom');
    const percent = windowZoomPercent(level);
    return (
        <>
            <span
                aria-label={isLive ? t('windowZoom.hud.percent', { percent }) : undefined}
                aria-live={isLive ? 'polite' : undefined}
                className="mr-1 min-w-10 text-center font-medium tabular-nums"
                role={isLive ? 'status' : undefined}
            >
                {percent}%
            </span>
            <ZoomIconButton
                commandId="view.zoomOut"
                disabled={level <= WINDOW_ZOOM_BOUNDS.min}
                icon={<Minus aria-hidden="true" size={14} />}
                label={t('windowZoom.hud.zoomOut')}
                step="out"
            />
            <ZoomIconButton
                commandId="view.zoomIn"
                disabled={level >= WINDOW_ZOOM_BOUNDS.max}
                icon={<Plus aria-hidden="true" size={14} />}
                label={t('windowZoom.hud.zoomIn')}
                step="in"
            />
            <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
            <Tooltip content={t('windowZoom.hud.resetTooltip')} shortcut={resetShortcut}>
                <Button
                    disabled={level === 0}
                    size="sm"
                    variant="ghost"
                    onClick={() => stepWindowZoom('reset')}
                >
                    {t('windowZoom.hud.reset')}
                </Button>
            </Tooltip>
        </>
    );
}
