import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { PerformanceMonitorMetrics } from '@caxri/protocol';
import type { PerformanceFrameSnapshot } from '@desktop-shared/performance-monitor';
import { GripHorizontal, X } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { performanceCollector } from './collector';
import { ModeSwitch } from './mode-switch';
import { openPerformanceMonitorWindow } from './monitor-commands';
import { MonitorPanel } from './monitor-panel';
import { useMonitorStore } from './monitor-store';
import { readPerformanceMetrics } from './performance-monitor-client';
import { useCardDrag } from './use-card-drag';

const READOUT_INTERVAL_MS = 250;
const METRICS_INTERVAL_MS = 2_000;

/**
 * Subscribes to this window's frame collector and Main's process readings for as long as the overlay is mounted.
 */
function useOverlayReadings(): {
    frames: PerformanceFrameSnapshot | undefined;
    metrics: PerformanceMonitorMetrics | undefined;
} {
    const [frames, setFrames] = useState<PerformanceFrameSnapshot>();
    const [metrics, setMetrics] = useState<PerformanceMonitorMetrics>();
    useEffect(() => {
        const release = performanceCollector.acquire();
        const readout = setInterval(
            () => setFrames(performanceCollector.snapshot()),
            READOUT_INTERVAL_MS,
        );
        let isCurrent = true;
        async function pollMetrics(): Promise<void> {
            try {
                const next = await readPerformanceMetrics();
                if (isCurrent) setMetrics(next);
            } catch {
                // Process readings are secondary; the frame readout keeps working without them.
            }
        }

        void pollMetrics();
        const metricsTimer = setInterval(() => {
            // Hidden windows stop sampling frames, and Main's process read would only burn CPU for nobody.

            if (document.visibilityState === 'visible') void pollMetrics();
        }, METRICS_INTERVAL_MS);
        return () => {
            isCurrent = false;
            clearInterval(readout);
            clearInterval(metricsTimer);
            release();
        };
    }, []);
    return { frames, metrics };
}

/**
 * Escape closes the card when focus is inside it or nowhere in particular (the state right after the command palette
 * hands focus back). Focus in a Terminal, editor, or field keeps Escape for that surface, as does a handler that
 * already consumed the key.
 */
function useEscapeToClose(card: RefObject<HTMLElement | null>, close: () => void): void {
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            const { target } = event;
            const isInsideCard = target instanceof Node && card.current?.contains(target) === true;
            const isUnfocused = target === document.body || target === document.documentElement;
            if (isInsideCard || isUnfocused) close();
        };
        addEventListener('keydown', onKeyDown);
        return () => removeEventListener('keydown', onKeyDown);
    }, [card, close]);
}

function ActivePerformanceOverlay() {
    const { t } = useTranslation();
    const cardReference = useRef<HTMLDivElement>(null);
    const saved = useMonitorStore((state) => state.position);
    const setPosition = useMonitorStore((state) => state.setPosition);
    const closeOverlay = useMonitorStore((state) => state.closeOverlay);
    const { handleProperties, position } = useCardDrag(cardReference, saved, setPosition);
    const { frames, metrics } = useOverlayReadings();
    useEscapeToClose(cardReference, closeOverlay);
    return (
        // The layer spans the window but only the card takes pointer input, so nothing underneath is blocked.
        <div className="pointer-events-none fixed inset-0 z-[100]" data-performance-overlay>
            <div
                ref={cardReference}
                aria-label={t('performanceMonitor.title')}
                className="pointer-events-auto absolute top-0 left-0 flex max-h-full w-64 max-w-full flex-col overflow-hidden rounded-md border border-border bg-elevated text-foreground shadow-[0_8px_24px_var(--shadow)] will-change-transform"
                role="dialog"
                style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)` }}
            >
                <div
                    className="flex h-6 shrink-0 cursor-grab touch-none items-center justify-between rounded-t-md border-b border-border pr-1 pl-2 text-muted select-none active:cursor-grabbing"
                    data-performance-drag-handle
                    {...handleProperties}
                >
                    <GripHorizontal aria-hidden="true" size={13} />
                    <span className="sr-only">{t('performanceMonitor.drag')}</span>
                    <Tooltip content={t('performanceMonitor.close')}>
                        <Button
                            aria-label={t('performanceMonitor.close')}
                            className="size-5 rounded"
                            size="icon"
                            variant="ghost"
                            onClick={closeOverlay}
                            onPointerDown={(event) => event.stopPropagation()}
                        >
                            <X aria-hidden="true" size={13} />
                        </Button>
                    </Tooltip>
                </div>
                <div className="min-h-0 overflow-y-auto p-3">
                    <MonitorPanel frames={frames} metrics={metrics} />
                    <div className="mt-3 flex justify-end">
                        <ModeSwitch current="overlay" onSelect={openPerformanceMonitorWindow} />
                    </div>
                </div>
            </div>
        </div>
    );
}

/**
 * The in-window monitor: a draggable card that exists, and samples, only while open.
 */
export function PerformanceOverlay() {
    const isOpen = useMonitorStore((state) => state.isOverlayOpen);
    return isOpen ? <ActivePerformanceOverlay /> : null;
}
