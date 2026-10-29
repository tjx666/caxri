import { TooltipProvider } from '../../components/ui/tooltip';
import { PerformanceMonitorApp } from './performance-monitor-app';

/**
 * Detached monitor entry content; a seam for the window's error boundary. The window is its own React root, so it
 * brings its own {@link TooltipProvider}.
 */
export function PerformanceMonitorRoot() {
    return (
        <TooltipProvider>
            <PerformanceMonitorApp />
        </TooltipProvider>
    );
}
