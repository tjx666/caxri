import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { ProcessErrorTarget, ProcessErrorWriter } from '../error-monitor';
import { installProcessErrorMonitor } from '../error-monitor';

function createWriter() {
    return {
        write: vi.fn<ProcessErrorWriter['write']>(),
    };
}

describe('installProcessErrorMonitor', () => {
    it('buffers an early fault until the structured logger is available', () => {
        // Node's `process` (the real production target) is an EventEmitter exposing
        // `uncaughtExceptionMonitor`, which has no EventTarget equivalent; the test double must
        // match that same Node-specific contract.
        // eslint-disable-next-line unicorn/prefer-event-target
        const target = new EventEmitter();
        const writer = createWriter();
        const monitor = installProcessErrorMonitor({
            processName: 'server-core',
            target: target as ProcessErrorTarget,
        });

        target.emit('uncaughtExceptionMonitor', new Error('startup failed'), 'uncaughtException');
        monitor.attach(writer);

        expect(writer.write).toHaveBeenCalledWith('error', 'server_core.uncaught_exception', {
            fields: {
                code: 'UNCAUGHT_EXCEPTION',
                errorType: 'Error',
                origin: 'uncaughtException',
            },
        });
    });

    it('uses the bootstrap writer before normal logger attachment', () => {
        // Node's `process` (the real production target) is an EventEmitter exposing
        // `uncaughtExceptionMonitor`, which has no EventTarget equivalent; the test double must
        // match that same Node-specific contract.
        // eslint-disable-next-line unicorn/prefer-event-target
        const target = new EventEmitter();
        const writer = createWriter();
        installProcessErrorMonitor({
            bootstrapWriter: () => writer,
            processName: 'desktop',
            target: target as ProcessErrorTarget,
        });

        target.emit('uncaughtExceptionMonitor', 'rejected', 'unhandledRejection');

        expect(writer.write).toHaveBeenCalledWith('error', 'desktop.unhandled_rejection', {
            fields: {
                code: 'UNHANDLED_REJECTION',
                errorType: 'string',
                origin: 'unhandledRejection',
            },
        });
    });

    it('observes without installing a handler that changes fatal error semantics', () => {
        // Node's `process` (the real production target) is an EventEmitter exposing
        // `uncaughtExceptionMonitor`, which has no EventTarget equivalent; the test double must
        // match that same Node-specific contract.
        // eslint-disable-next-line unicorn/prefer-event-target
        const target = new EventEmitter();
        const monitor = installProcessErrorMonitor({
            processName: 'desktop',
            target: target as ProcessErrorTarget,
        });

        expect(target.listenerCount('uncaughtExceptionMonitor')).toBe(1);
        expect(target.listenerCount('uncaughtException')).toBe(0);
        expect(target.listenerCount('unhandledRejection')).toBe(0);

        monitor.dispose();
        expect(target.listenerCount('uncaughtExceptionMonitor')).toBe(0);
    });
});
