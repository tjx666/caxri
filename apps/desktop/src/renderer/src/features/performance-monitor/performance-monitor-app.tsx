import { useEffect, useState } from 'react';

import type { PerformanceMonitorMetrics } from '@caxri/protocol';
import type {
    PerformanceFrameSnapshot,
    PerformanceMonitorState,
} from '@desktop-shared/performance-monitor';
import { RefreshCw, RotateCw } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Switch } from '../../components/ui/switch';
import { useTranslation } from '../../i18n';
import { ModeSwitch } from './mode-switch';
import { MonitorPanel } from './monitor-panel';
import { ReloadTimeline } from './reload-timeline';

/**
 * Bridge calls here are best effort: the next state push or poll corrects whatever a failed call left stale.
 */
async function run(call: () => Promise<unknown>): Promise<void> {
    try {
        await call();
    } catch {
        // Best effort, see above.
    }
}

function attempt(call: () => Promise<unknown>): void {
    void run(call);
}

const METRICS_INTERVAL_MS = 2_000;
/**
 * The Workbench publishes four snapshots a second, so this long without one means it stopped, not that it is idle.
 */
const STALE_AFTER_MS = 1_500;
const STALE_CHECK_INTERVAL_MS = 500;
const NO_RELOADS: PerformanceMonitorState['reloads'] = [];

/**
 * The detached monitor window: same readout as the overlay, fed by Main, plus the controls only a separate window can
 * offer (reloading the monitored Workbench and timing it).
 */
export function PerformanceMonitorApp() {
    const { t } = useTranslation();
    const [frames, setFrames] = useState<PerformanceFrameSnapshot>();
    const [metrics, setMetrics] = useState<PerformanceMonitorMetrics>();
    const [state, setState] = useState<PerformanceMonitorState>();
    const [isStale, setIsStale] = useState(false);
    const title = t('performanceMonitor.title');
    // Electron mirrors `document.title` onto the hidden-inset window, so the Window menu and Dock stay localized.
    useEffect(() => {
        document.title = title;
    }, [title]);
    useEffect(() => {
        const bridge = globalThis.performanceMonitor;
        let lastReceivedAt = Date.now();
        const offSnapshot = bridge.onSnapshot((snapshot) => {
            lastReceivedAt = Date.now();
            setIsStale(false);
            setFrames(snapshot);
        });
        const staleTimer = setInterval(
            () => setIsStale(Date.now() - lastReceivedAt > STALE_AFTER_MS),
            STALE_CHECK_INTERVAL_MS,
        );
        const offState = bridge.onState(setState);
        attempt(async () => setState(await bridge.getState()));
        async function poll(): Promise<void> {
            try {
                setMetrics(await bridge.metrics());
            } catch {
                // Process readings are secondary.
            }
        }

        void poll();
        const timer = setInterval(() => {
            void poll();
        }, METRICS_INTERVAL_MS);
        return () => {
            offSnapshot();
            offState();
            clearInterval(timer);
            clearInterval(staleTimer);
        };
    }, []);
    const target = state?.target ?? 'visible';
    const bridge = globalThis.performanceMonitor;
    return (
        <div className="flex h-screen flex-col bg-background text-foreground">
            <header className="flex h-9 shrink-0 items-center justify-center bg-title-bar-active-background px-12 pl-[84px] text-title-bar-active-foreground [-webkit-app-region:drag] window-inactive:bg-title-bar-inactive-background window-inactive:text-title-bar-inactive-foreground">
                <strong className="overflow-hidden text-[12px] text-ellipsis whitespace-nowrap">
                    {title}
                </strong>
            </header>
            <main className="min-h-0 flex-1 overflow-y-auto">
                {target === 'visible' ? null : (
                    <p
                        className="border-b border-border px-3 py-2 text-[12px] text-warning"
                        data-performance-target={target}
                    >
                        {t(`performanceMonitor.target.${target}`)}
                    </p>
                )}
                <div className="p-3">
                    <MonitorPanel frames={frames} isStale={isStale} metrics={metrics} />
                </div>
                <section className="border-t border-border">
                    <div className="flex items-center justify-between gap-2 px-3 py-2">
                        <h2 className="text-[12px] font-medium">
                            {t('performanceMonitor.reload.title')}
                        </h2>
                        <div className="flex gap-1.5">
                            <Button
                                data-performance-reload="reload"
                                size="sm"
                                variant="secondary"
                                onClick={() => attempt(() => bridge.reload({ ignoreCache: false }))}
                            >
                                <RotateCw aria-hidden="true" size={13} />
                                {t('performanceMonitor.reload.reload')}
                            </Button>
                            <Button
                                data-performance-reload="hard-reload"
                                size="sm"
                                variant="secondary"
                                onClick={() => attempt(() => bridge.reload({ ignoreCache: true }))}
                            >
                                <RefreshCw aria-hidden="true" size={13} />
                                {t('performanceMonitor.reload.hardReload')}
                            </Button>
                        </div>
                    </div>
                    <ReloadTimeline reloads={state?.reloads ?? NO_RELOADS} />
                </section>
            </main>
            <footer className="flex h-10 shrink-0 items-center justify-between border-t border-border px-3 text-[12px]">
                <label className="flex items-center gap-2 text-muted">
                    <Switch
                        aria-label={t('performanceMonitor.alwaysOnTop')}
                        checked={state?.alwaysOnTop ?? true}
                        onCheckedChange={(value) => attempt(() => bridge.setAlwaysOnTop(value))}
                    />
                    {t('performanceMonitor.alwaysOnTop')}
                </label>
                <ModeSwitch
                    current="window"
                    onSelect={() => attempt(() => bridge.switchToOverlay())}
                />
            </footer>
        </div>
    );
}
