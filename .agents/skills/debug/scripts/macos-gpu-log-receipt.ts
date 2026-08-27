import { z } from 'zod';

const MAX_RECEIPT_RECORDS = 500;

const unifiedLogRecordSchema = z.looseObject({
    timestamp: z.string().max(64).optional(),
    process: z.string().max(256).optional(),
    processImagePath: z.string().max(4_096).optional(),
    processID: z.number().int().nonnegative().optional(),
    eventMessage: z.string().max(32_768).optional(),
});

type Signal =
    | 'dock-space'
    | 'gpu-helper-lifecycle'
    | 'iogpu-shared-event'
    | 'metal-lifecycle'
    | 'window-server-lifecycle';

function processKind(record: z.infer<typeof unifiedLogRecordSchema>) {
    const source = `${record.process ?? ''} ${record.processImagePath ?? ''}`;
    if (source.includes('Caxri Helper (GPU)')) return 'caxri-gpu-helper' as const;
    if (source.includes('WindowServer')) return 'window-server' as const;
    if (source.includes('Dock')) return 'dock' as const;
    if (source.includes('kernel')) return 'kernel' as const;
    return;
}

function signalKind(
    record: z.infer<typeof unifiedLogRecordSchema>,
    process: NonNullable<ReturnType<typeof processKind>>,
): Signal | undefined {
    const message = record.eventMessage ?? '';
    if (/iogpu|bad event port|shared event/iu.test(message)) return 'iogpu-shared-event';
    if (/metal|mtl/iu.test(message)) return 'metal-lifecycle';
    if (process === 'caxri-gpu-helper') return 'gpu-helper-lifecycle';
    if (process === 'window-server') return 'window-server-lifecycle';
    if (process === 'dock' && /space|full.?screen|mission control/iu.test(message))
        return 'dock-space';
    return undefined;
}

/**
 * Converts macOS unified-log NDJSON into a bounded metadata-only receipt. Raw event messages and image paths are
 * deliberately unrepresentable in the result, even when an upstream framework writes user content into a log line.
 */
export function buildMacosGpuLogReceipt(source: string) {
    const records: Array<{
        process: NonNullable<ReturnType<typeof processKind>>;
        processId?: number;
        signal: Signal;
        timestamp?: string;
    }> = [];
    for (const line of source.split('\n')) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            continue;
        }
        const result = unifiedLogRecordSchema.safeParse(parsed);
        if (!result.success) continue;
        const process = processKind(result.data);
        if (!process) continue;
        const signal = signalKind(result.data, process);
        if (!signal) continue;
        records.push({
            process,
            signal,
            ...(result.data.processID !== undefined && { processId: result.data.processID }),
            ...(result.data.timestamp && { timestamp: result.data.timestamp }),
        });
        if (records.length === MAX_RECEIPT_RECORDS) break;
    }
    return { version: 1 as const, records };
}
