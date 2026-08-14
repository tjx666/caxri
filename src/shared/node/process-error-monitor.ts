import type { StructuredLogger } from './logger';

export type ProcessErrorWriter = Pick<StructuredLogger, 'write'>;

export interface ProcessErrorTarget {
    on(
        event: 'uncaughtExceptionMonitor',
        listener: (error: unknown, origin: NodeJS.UncaughtExceptionOrigin) => void,
    ): unknown;
    off(
        event: 'uncaughtExceptionMonitor',
        listener: (error: unknown, origin: NodeJS.UncaughtExceptionOrigin) => void,
    ): unknown;
}

interface ProcessErrorMonitorOptions {
    bootstrapWriter?: () => ProcessErrorWriter | undefined;
    processName: 'host' | 'main' | 'runtime';
    target?: ProcessErrorTarget;
}

interface BufferedProcessError {
    event: string;
    fields: {
        code: string;
        errorType: string;
        origin: NodeJS.UncaughtExceptionOrigin;
    };
}

const MAX_BUFFERED_PROCESS_ERRORS = 8;
function errorType(error: unknown): string {
    return error instanceof Error ? error.name : typeof error;
}

/**
 * Observes fatal process errors through `uncaughtExceptionMonitor`, which does not suppress Node's
 * default crash behavior. A small buffer covers startup before the ordinary logger is attached;
 * callers may also provide a synchronous bootstrap writer so a process that exits immediately
 * still leaves a structured record.
 */
export function installProcessErrorMonitor(options: ProcessErrorMonitorOptions): {
    attach(writer: ProcessErrorWriter): void;
    dispose(): void;
} {
    const target = options.target ?? process;
    const buffered: BufferedProcessError[] = [];
    let writer: ProcessErrorWriter | undefined;

    const write = (record: BufferedProcessError): boolean => {
        try {
            writer ??= options.bootstrapWriter?.();
            if (!writer) return false;
            writer.write('error', record.event, { fields: record.fields });
            return true;
        } catch {
            /** Logging must never replace or delay the process's original fatal-error semantics. */
            return false;
        }
    };
    const listener = (error: unknown, origin: NodeJS.UncaughtExceptionOrigin): void => {
        const isRejection = origin === 'unhandledRejection';
        const record: BufferedProcessError = {
            event: `${options.processName}.${isRejection ? 'unhandled_rejection' : 'uncaught_exception'}`,
            fields: {
                code: isRejection ? 'UNHANDLED_REJECTION' : 'UNCAUGHT_EXCEPTION',
                errorType: errorType(error),
                origin,
            },
        };
        if (!write(record) && buffered.length < MAX_BUFFERED_PROCESS_ERRORS) buffered.push(record);
    };

    target.on('uncaughtExceptionMonitor', listener);
    return {
        attach(nextWriter) {
            writer = nextWriter;
            for (const record of buffered.splice(0)) write(record);
        },
        dispose() {
            target.off('uncaughtExceptionMonitor', listener);
        },
    };
}
