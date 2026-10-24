import { PerformanceMonitorApp } from './performance-monitor-app';

/**
 * Detached monitor entry content; a seam for the window's error boundary.
 */
export function PerformanceMonitorRoot() {
    return <PerformanceMonitorApp />;
}
