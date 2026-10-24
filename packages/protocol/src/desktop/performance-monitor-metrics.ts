import { z } from 'zod';

/**
 * Which Caxri process a reading belongs to. Several Renderers and helpers collapse into the role a person asks about
 * ("how busy is the GPU process?"); anything unrecognised folds into `other`.
 */
const performanceMonitorProcessRoleSchema = z.enum([
    'workbench',
    'browser',
    'gpu',
    'server',
    'other',
]);

const performanceMonitorProcessReadingSchema = z.object({
    role: performanceMonitorProcessRoleSchema,
    cpuPercent: z.number().nonnegative(),
    memoryMb: z.number().nonnegative(),
});

/**
 * One Performance Monitor sample of the processes Main can see. CPU is Electron's percentage since the previous sample,
 * so a role summed from several processes can exceed 100 on a multi-core machine.
 */
export const performanceMonitorMetricsSchema = z.object({
    sampledAt: z.number(),
    /**
     * `state` is the verdict the monitor shows (`on` for any enabled rasterization path); `raw` is Chromium's own
     * `getGPUFeatureStatus().rasterization` string, kept for the tooltip. `unknown` means Electron reported no such
     * key.
     */
    gpuRaster: z.object({
        state: z.enum(['on', 'off', 'unknown']),
        raw: z.string().max(64),
    }),
    processes: z.array(performanceMonitorProcessReadingSchema).max(16),
});

export type PerformanceMonitorMetrics = z.infer<typeof performanceMonitorMetricsSchema>;
export type PerformanceMonitorProcessRole = z.infer<typeof performanceMonitorProcessRoleSchema>;
