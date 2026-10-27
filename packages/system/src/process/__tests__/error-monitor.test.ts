import { EventEmitter } from 'node:events';

import { serverEventSchema, sourceControlViewStatesSchema } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ProcessErrorWriter } from '../error-monitor';
import { installProcessErrorMonitor } from '../error-monitor';

function createWriter() {
    return {
        write: vi.fn<ProcessErrorWriter['write']>(),
    };
}

describe('installProcessErrorMonitor', () => {
    it('records bounded Zod issue path shapes and codes without rejected values', () => {
        // eslint-disable-next-line unicorn/prefer-event-target -- Matches Node's process error surface.
        const target = new EventEmitter();
        const writer = createWriter();
        const monitor = installProcessErrorMonitor({
            processName: 'server-core',
            target,
        });
        monitor.attach(writer);
        const parsed = serverEventSchema.safeParse({
            event: 'files.changed',
            payload: {
                sessionId: 'session-1',
                workbenchRootProjectId: 'project-1',
                changes: Array.from({ length: 513 }, (_, index) => ({
                    path: `/private/source-${index}.txt`,
                    kind: 'update',
                })),
                overflow: false,
            },
        });
        if (parsed.success) throw new Error('Expected fixture validation to fail');

        target.emit('uncaughtExceptionMonitor', parsed.error, 'uncaughtException');

        expect(writer.write).toHaveBeenCalledWith('error', 'server_core.uncaught_exception', {
            fields: {
                code: 'UNCAUGHT_EXCEPTION',
                errorType: 'ZodError',
                origin: 'uncaughtException',
                validationIssues: '<field>.<field>:too_big',
            },
        });
        expect(JSON.stringify(writer.write.mock.calls)).not.toContain('/private/source-');
    });

    it('does not expose dynamic record keys through Zod issue paths', () => {
        // eslint-disable-next-line unicorn/prefer-event-target -- Matches Node's process error surface.
        const target = new EventEmitter();
        const writer = createWriter();
        const monitor = installProcessErrorMonitor({
            processName: 'server-core',
            target,
        });
        monitor.attach(writer);
        const parsed = sourceControlViewStatesSchema.safeParse({ privateCredentialName: {} });
        if (parsed.success) throw new Error('Expected fixture validation to fail');

        target.emit('uncaughtExceptionMonitor', parsed.error, 'uncaughtException');

        expect(JSON.stringify(writer.write.mock.calls)).not.toContain('privateCredentialName');
    });

    it('buffers an early fault until the structured logger is available', () => {
        // Node's `process` (the real production target) is an EventEmitter exposing
        // `uncaughtExceptionMonitor`, which has no EventTarget equivalent; the test double must
        // match that same Node-specific contract.
        // eslint-disable-next-line unicorn/prefer-event-target
        const target = new EventEmitter();
        const writer = createWriter();
        const monitor = installProcessErrorMonitor({
            processName: 'server-core',
            target,
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
            target,
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
            target,
        });

        expect(target.listenerCount('uncaughtExceptionMonitor')).toBe(1);
        expect(target.listenerCount('uncaughtException')).toBe(0);
        expect(target.listenerCount('unhandledRejection')).toBe(0);

        monitor.dispose();
        expect(target.listenerCount('uncaughtExceptionMonitor')).toBe(0);
    });
});
