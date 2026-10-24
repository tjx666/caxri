import type { ReactNode } from 'react';

import type { PerformanceMonitorMetrics, PerformanceMonitorProcessRole } from '@caxri/protocol';
import type { PerformanceFrameSnapshot } from '@desktop-shared/performance-monitor';
import { PERFORMANCE_MONITOR_FRAME_CAPACITY } from '@desktop-shared/performance-monitor';

import { Tooltip } from '../../components/ui/tooltip';
import type { TranslationKey } from '../../i18n';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import type { MonitorTone } from './format';
import { formatCpu, formatFps, formatMegabytes, formatMilliseconds, fpsTone } from './format';
import { FrameGraph } from './frame-graph';

const TONE_CLASS: Record<MonitorTone, string> = {
    bad: 'text-danger',
    good: 'text-success',
    idle: 'text-muted',
    warn: 'text-warning',
};

const ROLE_LABEL: Record<PerformanceMonitorProcessRole, TranslationKey> = {
    browser: 'performanceMonitor.role.browser',
    gpu: 'performanceMonitor.role.gpu',
    other: 'performanceMonitor.role.other',
    server: 'performanceMonitor.role.server',
    workbench: 'performanceMonitor.role.workbench',
};

function Row({ children, hint, label }: { children: ReactNode; hint?: string; label: string }) {
    const labelNode = <span className="text-muted">{label}</span>;
    return (
        <div className="flex items-baseline justify-between gap-3">
            {hint ? <Tooltip content={hint}>{labelNode}</Tooltip> : labelNode}
            <span className="text-right text-foreground tabular-nums">{children}</span>
        </div>
    );
}

type Frames = PerformanceFrameSnapshot | undefined;

function FpsHeader({ frames, isLive }: { frames: Frames; isLive: boolean }) {
    const { t } = useTranslation();
    const tone = frames && isLive ? fpsTone(frames.fps) : 'idle';
    return (
        <div className="flex items-baseline justify-between gap-2">
            <Tooltip content={t('performanceMonitor.fpsHint')}>
                <span
                    className={cn(
                        'font-mono text-[15px] font-semibold tabular-nums',
                        TONE_CLASS[tone],
                    )}
                    data-performance-fps
                >
                    {frames && isLive ? formatFps(frames.fps) : '–'}
                    <span className="ml-1 text-[11px] font-normal text-muted">
                        {t('performanceMonitor.fps')}
                    </span>
                </span>
            </Tooltip>
            {frames && isLive && frames.fps > 0 && (
                <span className="text-right text-muted tabular-nums">
                    {t('performanceMonitor.min', { value: formatFps(frames.minFps) })}
                    {' · '}
                    {t('performanceMonitor.low', { value: formatFps(frames.lowFps) })}
                </span>
            )}
        </div>
    );
}

function ProcessTable({ processes }: { processes: PerformanceMonitorMetrics['processes'] }) {
    const { t } = useTranslation();
    return (
        <div className="grid gap-0.5 border-t border-border pt-2">
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 text-muted">
                <span>{t('performanceMonitor.processes')}</span>
                <span className="text-right">{t('performanceMonitor.cpu')}</span>
                <span className="text-right">{t('performanceMonitor.memory')}</span>
            </div>
            {processes.map((process) => (
                <div
                    key={process.role}
                    className="grid grid-cols-[1fr_auto_auto] gap-x-3 tabular-nums"
                    data-performance-process={process.role}
                >
                    <span className="text-muted">{t(ROLE_LABEL[process.role])}</span>
                    <span className="min-w-12 text-right">{formatCpu(process.cpuPercent)}</span>
                    <span className="min-w-16 text-right">{formatMegabytes(process.memoryMb)}</span>
                </div>
            ))}
        </div>
    );
}

function FrameDetails({ frames }: { frames: Frames }) {
    const { t } = useTranslation();
    return (
        <div className="grid gap-0.5 border-t border-border pt-2">
            <Row label={t('performanceMonitor.jsHeap')}>
                {frames?.jsHeapUsedMb == null
                    ? '–'
                    : `${formatMegabytes(frames.jsHeapUsedMb)} / ${Math.round(frames.jsHeapLimitMb ?? 0)} MB`}
            </Row>
            <Row label={t('performanceMonitor.longFrames')}>
                <span data-performance-long-frames={frames?.longFrameCount ?? 0}>
                    {frames?.lastLongFrameMs == null
                        ? (frames?.longFrameCount ?? 0)
                        : t('performanceMonitor.longFramesValue', {
                              count: frames.longFrameCount,
                              last: formatMilliseconds(frames.lastLongFrameMs),
                          })}
                </span>
            </Row>
            <Row label={t('performanceMonitor.sessionSwitch')}>
                {frames?.lastSessionSwitchMs == null
                    ? t('performanceMonitor.none')
                    : formatMilliseconds(frames.lastSessionSwitchMs)}
            </Row>
            <Row
                label={t('performanceMonitor.monitorCost')}
                hint={t('performanceMonitor.monitorCostHint')}
            >
                {frames ? `${frames.monitorCostUs.toFixed(0)} µs` : '–'}
            </Row>
        </div>
    );
}

/**
 * The monitor's readout, shared by the in-window overlay and the detached window: both only differ in where the two
 * inputs come from (this window's collector, or Main's relay of the Workbench's).
 */
export function MonitorPanel({
    frames,
    isStale = false,
    metrics,
}: {
    frames: Frames;
    /**
     * The latest snapshot stopped arriving, e.g. the monitored Workbench is blocked; its numbers are no longer current.
     */
    isStale?: boolean;
    metrics: PerformanceMonitorMetrics | undefined;
}) {
    const { t } = useTranslation();
    const processes = metrics?.processes ?? [];
    const gpu = processes.find((process) => process.role === 'gpu');
    const isLive = frames !== undefined && !frames.paused && !isStale;
    return (
        <div className="grid gap-2 text-[11px] leading-[1.45]" data-performance-panel>
            <FpsHeader frames={frames} isLive={isLive} />
            <FrameGraph
                frameMs={frames?.frameMs ?? []}
                label={t('performanceMonitor.frameGraph', {
                    count: PERFORMANCE_MONITOR_FRAME_CAPACITY,
                })}
            />
            {frames?.paused && !isStale && (
                <p className="m-0 text-muted">{t('performanceMonitor.paused')}</p>
            )}
            {isStale && <p className="m-0 text-warning">{t('performanceMonitor.stale')}</p>}
            {!frames && <p className="m-0 text-muted">{t('performanceMonitor.waiting')}</p>}
            <div className="grid gap-0.5">
                <Row
                    label={t('performanceMonitor.gpuRaster')}
                    hint={
                        metrics?.gpuRaster.raw
                            ? t('performanceMonitor.gpuRasterHint', { raw: metrics.gpuRaster.raw })
                            : undefined
                    }
                >
                    {metrics ? t(`performanceMonitor.gpuRaster.${metrics.gpuRaster.state}`) : '–'}
                </Row>
                <Row
                    label={t('performanceMonitor.gpuProcessMemory')}
                    hint={t('performanceMonitor.gpuProcessMemoryHint')}
                >
                    {gpu ? formatMegabytes(gpu.memoryMb) : '–'}
                </Row>
            </div>
            <ProcessTable processes={processes} />
            <FrameDetails frames={frames} />
        </div>
    );
}
