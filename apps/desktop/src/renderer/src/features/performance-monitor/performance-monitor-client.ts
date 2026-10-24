import type { PerformanceMonitorMetrics } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';

/**
 * Reads the process and GPU raster readings Main keeps for the monitor.
 */
export function readPerformanceMetrics(): Promise<PerformanceMonitorMetrics> {
    return caxri.request('performanceMonitor.metrics');
}
