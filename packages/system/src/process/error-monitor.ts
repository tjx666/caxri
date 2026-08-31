import process from 'node:process';

import type { LogEventName, LogProcess } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/protocol';

import type { StructuredLogger } from '../observability/logger.js';

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
    processName: LogProcess;
    target?: ProcessErrorTarget;
}

interface BufferedProcessError {
    event: LogEventName;
    fields: {
        code: string;
        errorType: string;
        origin: NodeJS.UncaughtExceptionOrigin;
        validationIssues?: string;
    };
}

const MAX_BUFFERED_PROCESS_ERRORS = 8;
const MAX_REPORTED_VALIDATION_ISSUES = 5;
const MAX_VALIDATION_PATH_SEGMENTS = 8;
const MAX_VALIDATION_ISSUES_LENGTH = 512;
const processErrorEvents = {
    'desktop': {
        uncaughtException: logEventCatalog.desktop.uncaughtException,
        unhandledRejection: logEventCatalog.desktop.unhandledRejection,
    },
    'extension-host': {
        uncaughtException: logEventCatalog.extensionHost.uncaughtException,
        unhandledRejection: logEventCatalog.extensionHost.unhandledRejection,
    },
    'server-core': {
        uncaughtException: logEventCatalog.serverCore.uncaughtException,
        unhandledRejection: logEventCatalog.serverCore.unhandledRejection,
    },
    'terminal-host': {
        uncaughtException: logEventCatalog.terminalHost.uncaughtException,
        unhandledRejection: logEventCatalog.terminalHost.unhandledRejection,
    },
} as const satisfies Record<
    ProcessErrorMonitorOptions['processName'],
    Record<'uncaughtException' | 'unhandledRejection', LogEventName>
>;
function errorType(error: unknown): string {
    return error instanceof Error ? error.name : typeof error;
}

/**
 * Retains only path shape because Zod paths do not distinguish schema field names from dynamic record keys. Even an
 * identifier-looking segment may therefore contain user data or a credential name.
 */
function validationIssues(error: unknown): string | undefined {
    try {
        if (!(error instanceof Error) || error.name !== 'ZodError') return undefined;
        const rawIssues: unknown = (error as Error & { issues?: unknown }).issues;
        if (!Array.isArray(rawIssues)) return undefined;
        return rawIssues
            .slice(0, MAX_REPORTED_VALIDATION_ISSUES)
            .map((issue) => {
                if (typeof issue !== 'object' || issue === null) return 'unknown:unknown';
                const issueRecord = issue as Record<string, unknown>;
                const rawPath: unknown = issueRecord.path;
                const path = Array.isArray(rawPath)
                    ? rawPath
                          .slice(0, MAX_VALIDATION_PATH_SEGMENTS)
                          .map((segment) => {
                              if (typeof segment === 'number') return '*';
                              return typeof segment === 'string' ? '<field>' : '<key>';
                          })
                          .join('.')
                    : 'unknown';
                const rawCode: unknown = issueRecord.code;
                const code =
                    typeof rawCode === 'string' && /^[a-z][a-z_]{0,63}$/.test(rawCode)
                        ? rawCode
                        : 'unknown';
                return `${path || 'root'}:${code}`;
            })
            .join(',')
            .slice(0, MAX_VALIDATION_ISSUES_LENGTH);
    } catch {
        /**
         * Fatal-error observation must remain passive even for a malformed cross-realm Zod-shaped error.
         */
        return undefined;
    }
}

/**
 * Observes fatal process errors through `uncaughtExceptionMonitor`, which does not suppress Node's default crash
 * behavior. A small buffer covers startup before the ordinary logger is attached; callers may also provide a
 * synchronous bootstrap writer so a process that exits immediately still leaves a structured record.
 */
export function installProcessErrorMonitor(options: ProcessErrorMonitorOptions): {
    attach(writer: ProcessErrorWriter): void;
    dispose(): void;
} {
    const target = options.target ?? process;
    const buffered: BufferedProcessError[] = [];
    let writer: ProcessErrorWriter | undefined;

    const didWrite = (record: BufferedProcessError): boolean => {
        try {
            writer ??= options.bootstrapWriter?.();
            if (!writer) return false;
            writer.write('error', record.event, { fields: record.fields });
            return true;
        } catch {
            /**
             * Logging must never replace or delay the process's original fatal-error semantics.
             */
            return false;
        }
    };
    const listener = (error: unknown, origin: NodeJS.UncaughtExceptionOrigin): void => {
        const isRejection = origin === 'unhandledRejection';
        const validationIssueSummary = validationIssues(error);
        const record: BufferedProcessError = {
            event: isRejection
                ? processErrorEvents[options.processName].unhandledRejection
                : processErrorEvents[options.processName].uncaughtException,
            fields: {
                code: isRejection ? 'UNHANDLED_REJECTION' : 'UNCAUGHT_EXCEPTION',
                errorType: errorType(error),
                origin,
                ...(validationIssueSummary && { validationIssues: validationIssueSummary }),
            },
        };
        if (!didWrite(record) && buffered.length < MAX_BUFFERED_PROCESS_ERRORS)
            buffered.push(record);
    };

    target.on('uncaughtExceptionMonitor', listener);
    return {
        attach(nextWriter) {
            writer = nextWriter;
            const pending = [...buffered];
            buffered.length = 0;
            for (const record of pending) didWrite(record);
        },
        dispose() {
            target.off('uncaughtExceptionMonitor', listener);
        },
    };
}
