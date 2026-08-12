import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
    installProcessErrorMonitor,
    type ProcessErrorTarget,
    type ProcessErrorWriter,
} from '../process-error-monitor';

function createWriter() {
    return {
        write: vi.fn<ProcessErrorWriter['write']>(),
    };
}

describe('installProcessErrorMonitor', () => {
    it('buffers an early fault until the structured logger is available', () => {
        const target = new EventEmitter();
        const writer = createWriter();
        const monitor = installProcessErrorMonitor({
            processName: 'runtime',
            target: target as ProcessErrorTarget,
        });

        target.emit('uncaughtExceptionMonitor', new Error('startup failed'), 'uncaughtException');
        monitor.attach(writer);

        expect(writer.write).toHaveBeenCalledWith('error', 'runtime.uncaught_exception', {
            fields: {
                code: 'UNCAUGHT_EXCEPTION',
                errorType: 'Error',
                origin: 'uncaughtException',
            },
        });
    });

    it('uses the bootstrap writer before normal logger attachment', () => {
        const target = new EventEmitter();
        const writer = createWriter();
        installProcessErrorMonitor({
            bootstrapWriter: () => writer,
            processName: 'main',
            target: target as ProcessErrorTarget,
        });

        target.emit('uncaughtExceptionMonitor', 'rejected', 'unhandledRejection');

        expect(writer.write).toHaveBeenCalledWith('error', 'main.unhandled_rejection', {
            fields: {
                code: 'UNHANDLED_REJECTION',
                errorType: 'string',
                origin: 'unhandledRejection',
            },
        });
    });

    it('observes without installing a handler that changes fatal error semantics', () => {
        const target = new EventEmitter();
        const monitor = installProcessErrorMonitor({
            processName: 'main',
            target: target as ProcessErrorTarget,
        });

        expect(target.listenerCount('uncaughtExceptionMonitor')).toBe(1);
        expect(target.listenerCount('uncaughtException')).toBe(0);
        expect(target.listenerCount('unhandledRejection')).toBe(0);

        monitor.dispose();
        expect(target.listenerCount('uncaughtExceptionMonitor')).toBe(0);
    });
});
