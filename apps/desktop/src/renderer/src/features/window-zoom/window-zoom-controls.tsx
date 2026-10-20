import type { ReactElement } from 'react';

import { Minus, Plus } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import type { WindowZoomStep } from './window-zoom-commands';
import { stepWindowZoom, WINDOW_ZOOM_BOUNDS, windowZoomPercent } from './window-zoom-commands';

function ZoomIconButton({
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
 * The current percentage with Zoom Out, Zoom In, and Reset beside it: the row the transient zoom HUD shows and the
 * persistent zoom indicator opens, so both read and act the same way.
 */
export function WindowZoomControls({ level }: { level: number }) {
    const { t } = useTranslation();
    const percent = windowZoomPercent(level);
    return (
        <>
            <span
                aria-label={t('windowZoom.hud.percent', { percent })}
                aria-live="polite"
                className="mr-1 min-w-10 text-center font-medium tabular-nums"
                role="status"
            >
                {percent}%
            </span>
            <ZoomIconButton
                disabled={level <= WINDOW_ZOOM_BOUNDS.min}
                icon={<Minus aria-hidden="true" size={14} />}
                label={t('windowZoom.hud.zoomOut')}
                step="out"
            />
            <ZoomIconButton
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
        </>
    );
}
