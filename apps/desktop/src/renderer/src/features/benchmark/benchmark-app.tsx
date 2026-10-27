import { useEffect } from 'react';

import { CaxriLogo } from '../../components/caxri-logo';
import { TooltipProvider } from '../../components/ui/tooltip';
import { useWorkbenchAppearance } from '../../hooks/use-workbench-appearance';
import { useTranslation } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { cn } from '../../lib/utilities';
import { queryClient } from '../../queries/client';
import { useIsFullScreen } from '../../stores/selectors';
import { syncWindowFullScreen } from '../../stores/window-full-screen';
import { initializeWorkbench, refreshWorkbench, useWorkbenchStore } from '../../stores/workbench';
import { ConfirmationDialog } from '../confirmations/confirmation-dialog';
import { ToastOutlet } from '../toasts/toast-outlet';
import { useWindowZoomFactor } from '../window-zoom/use-window-zoom-factor';
import { BenchmarkPage } from './benchmark-page';
import { benchmarkWindowEventEffect } from './benchmark-window-events';

/**
 * Keeps the window's snapshot (Projects, Settings, theme) and fullscreen chrome current. The window reads the same
 * `app.bootstrap` snapshot as the Workbench, so locale, theme, and the Project list follow it without a reader of their
 * own.
 */
function useBenchmarkWindowState(): void {
    useEffect(() => {
        void initializeWorkbench();
        const unsubscribe = caxri.onEvent((event) => {
            const effect = benchmarkWindowEventEffect(event);
            if (effect.isFullScreen !== undefined)
                useWorkbenchStore.setState({ isFullScreen: effect.isFullScreen });
            if (effect.snapshot) void refreshWorkbench();
            if (effect.runs)
                void queryClient.invalidateQueries({
                    predicate: (query) => String(query.queryKey[0]).startsWith('benchmark.'),
                });
        });
        void syncWindowFullScreen();
        return unsubscribe;
    }, []);
}

/**
 * The window's title bar and drag region. Its left padding clears the macOS `hiddenInset` traffic lights; in fullscreen
 * they are gone, so the logo takes their place, as in the Caxri Bot window.
 */
function BenchmarkHeader() {
    const { t } = useTranslation();
    const isFullScreen = useIsFullScreen();
    return (
        <header
            className={cn(
                'flex h-9 flex-none items-center gap-2 bg-surface pr-3 [-webkit-app-region:drag]',
                isFullScreen ? 'pl-3' : 'pl-(--traffic-light-clearance)',
            )}
        >
            {isFullScreen && <CaxriLogo />}
            <h1 className="m-0 text-[13px] font-medium">{t('benchmark.title')}</h1>
        </header>
    );
}

/**
 * The Benchmark window: run history on the left, the New run form or one run's results on the right. It renders no
 * Workbench chrome and runs no Workbench commands; menu accelerators stay with the Workbench window. See
 * `docs/benchmark.md`.
 */
export function BenchmarkApp() {
    useWorkbenchAppearance();
    useWindowZoomFactor();
    useBenchmarkWindowState();
    return (
        <TooltipProvider>
            <div
                className="flex h-screen w-screen flex-col bg-background text-foreground"
                data-benchmark-window
            >
                <BenchmarkHeader />
                <main className="min-h-0 flex-1">
                    <BenchmarkPage />
                </main>
                <ConfirmationDialog />
                <ToastOutlet />
            </div>
        </TooltipProvider>
    );
}
