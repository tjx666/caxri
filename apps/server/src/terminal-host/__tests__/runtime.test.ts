import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TerminalRecord } from '@caxri/protocol';
import type { ObservationContext } from '@caxri/system';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalHostMessage, TerminalHostRequestEnvelope } from '../protocol';
import { terminalHostRequestEnvelopeSchema } from '../protocol';
import type { TerminalExecutionOwner } from '../runtime';
import { TerminalHostRuntime } from '../runtime';

const credential = 'a'.repeat(64);
const bootId = 'b'.repeat(32);
const terminal: TerminalRecord = {
    id: 'terminal-1',
    sessionId: 'session-1',
    cwd: '/project',
    kind: 'shell',
    title: 'Shell',
    icon: 'terminal',
    orderIndex: 0,
    lastProcessState: 'starting',
    createdAt: 1,
    updatedAt: 1,
};
const temporaryDirectories: string[] = [];

function privateRequest(
    request: TerminalHostRequestEnvelope['request'],
    scope: TerminalHostRequestEnvelope['scope'],
    id: string,
    observation?: ObservationContext,
): TerminalHostRequestEnvelope {
    return terminalHostRequestEnvelopeSchema.parse({
        type: 'request',
        protocolVersion: 1,
        id,
        ...(observation && { observation }),
        bootId,
        credential,
        scope,
        request,
    });
}

function fakeEngine(): {
    attach: ReturnType<typeof vi.fn>;
    owner: TerminalExecutionOwner;
    snapshot: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
} {
    const attach = vi.fn(() => Promise.resolve({ snapshot: null, wasAttached: false }));
    const snapshot = vi.fn(() => Promise.resolve(null));
    const start = vi.fn(() => 42);
    const write = vi.fn(() => true);
    return {
        attach,
        snapshot,
        start,
        write,
        owner: {
            attach,
            close: vi.fn(),
            detachAllViews: vi.fn(),
            detachView: vi.fn(),
            processId: vi.fn(() => 42),
            reassignSession: vi.fn(),
            reconcileOutputRecoverySettings: vi.fn(),
            resize: vi.fn(() => true),
            resources: vi.fn(() => Promise.resolve(null)),
            restartBarrier: vi.fn(),
            runningCount: vi.fn(() => 1),
            shutdown: vi.fn(() => []),
            signalExact: vi.fn(() => true),
            snapshot,
            start,
            waitForAttachedSize: vi.fn(async () => {}),
            write,
        },
    };
}

function createRuntime(engine: TerminalExecutionOwner): {
    logger: StructuredLogger;
    messages: TerminalHostMessage[];
    runtime: TerminalHostRuntime;
    protocolViolation: ReturnType<typeof vi.fn>;
} {
    const directory = mkdtempSync(join(tmpdir(), 'caxri-terminal-host-runtime-'));
    temporaryDirectories.push(directory);
    const messages: TerminalHostMessage[] = [];
    const protocolViolation = vi.fn();
    const logger = new StructuredLogger(join(directory, 'logs'), 'terminal-host');
    return {
        logger,
        messages,
        protocolViolation,
        runtime: new TerminalHostRuntime({
            appVersion: '0.0.18',
            bootId,
            buildId: 'build-1',
            commit: 'deadbeef',
            credential,
            engine,
            logger,
            onProtocolViolation: protocolViolation,
            send: (message) => messages.push(message),
        }),
    };
}

afterEach(() => {
    for (const directory of temporaryDirectories)
        rmSync(directory, { force: true, recursive: true });
    temporaryDirectories.length = 0;
});

describe('architecture-a3b-terminal-host: TerminalHostRuntime', () => {
    it('fences a reserved generation and dispatches the authorized execution sequence', async () => {
        const engine = fakeEngine();
        const { messages, runtime } = createRuntime(engine.owner);
        const lifecycleScope = {
            scope: 'terminal',
            capability: 'terminal.lifecycle',
            sessionId: terminal.sessionId,
            terminalId: terminal.id,
            ptyGeneration: 1,
        } as const;
        await runtime.accept(
            privateRequest(
                { method: 'terminal.reserve', params: terminal },
                lifecycleScope,
                'reserve-1',
            ),
        );
        await runtime.accept(
            privateRequest(
                {
                    method: 'terminal.start',
                    params: {
                        record: terminal,
                        executable: '/bin/zsh',
                        args: ['-l'],
                        environment: { TERM: 'xterm-256color' },
                    },
                },
                lifecycleScope,
                'start-1',
            ),
        );
        const inputScope = {
            ...lifecycleScope,
            capability: 'terminal.input',
            attachmentId: 'attachment-1',
        } as const;
        await runtime.accept(
            privateRequest(
                {
                    method: 'terminal.attach',
                    params: { attachmentId: 'attachment-1', size: { cols: 120, rows: 40 } },
                },
                { ...inputScope, capability: 'terminal.view' },
                'attach-1',
            ),
        );
        await runtime.accept(
            privateRequest(
                { method: 'terminal.input', params: { data: 'echo safe\r' } },
                inputScope,
                'input-1',
            ),
        );

        expect(engine.start).toHaveBeenCalledOnce();
        expect(engine.attach).toHaveBeenCalledWith(terminal.id, { cols: 120, rows: 40 });
        expect(engine.write).toHaveBeenCalledWith(terminal.id, 'echo safe\r');
        expect(messages.at(-1)).toEqual({
            type: 'reply',
            id: 'input-1',
            ok: true,
            result: { accepted: true },
        });
    });

    it('rejects stale generations without disclosing the authorization reason', async () => {
        const engine = fakeEngine();
        const { messages, runtime } = createRuntime(engine.owner);
        const lifecycleScope = {
            scope: 'terminal',
            capability: 'terminal.lifecycle',
            sessionId: terminal.sessionId,
            terminalId: terminal.id,
            ptyGeneration: 1,
        } as const;
        await runtime.accept(
            privateRequest(
                {
                    method: 'terminal.start',
                    params: {
                        record: terminal,
                        executable: '/bin/zsh',
                        args: [],
                        environment: {},
                    },
                },
                lifecycleScope,
                'start-1',
            ),
        );
        await runtime.accept(
            privateRequest(
                { method: 'terminal.snapshot', params: {} },
                {
                    ...lifecycleScope,
                    capability: 'terminal.view',
                    ptyGeneration: 2,
                },
                'snapshot-stale',
            ),
        );

        expect(messages.at(-1)).toEqual({
            type: 'reply',
            id: 'snapshot-stale',
            ok: false,
            error: {
                code: 'CAPABILITY_DENIED',
                message: 'Terminal Host request was not authorized',
            },
        });
        expect(engine.snapshot).not.toHaveBeenCalled();
    });

    it('fails closed on malformed or oversized parent messages', async () => {
        const { protocolViolation, runtime } = createRuntime(fakeEngine().owner);
        await runtime.accept({ type: 'request', credential: 'secret' });
        expect(protocolViolation).toHaveBeenCalledOnce();
    });

    it('correlates failures without logging private request parameters', async () => {
        const engine = fakeEngine();
        engine.start.mockImplementation(() => {
            throw new Error('private-environment-value');
        });
        const { logger, runtime } = createRuntime(engine.owner);
        await runtime.accept(
            privateRequest(
                {
                    method: 'terminal.start',
                    params: {
                        record: terminal,
                        executable: '/bin/zsh',
                        args: ['private-argument'],
                        environment: { PRIVATE_TOKEN: 'private-environment-value' },
                    },
                },
                {
                    scope: 'terminal',
                    capability: 'terminal.lifecycle',
                    sessionId: terminal.sessionId,
                    terminalId: terminal.id,
                    ptyGeneration: 1,
                },
                'start-failure-1',
                {
                    requestId: 'public-request-1',
                    traceId: 'public-trace-1',
                },
            ),
        );
        await logger.flush();

        const log = await readFile(logger.path, 'utf8');
        expect(log).toContain('"event":"terminal_host.request_failed"');
        expect(log).toContain('"correlationId":"start-failure-1"');
        expect(log).toContain('"method":"terminal.start"');
        expect(log).toContain('"traceId":"public-trace-1"');
        expect(log).not.toContain('private-argument');
        expect(log).not.toContain('private-environment-value');
        expect(log).not.toContain('PRIVATE_TOKEN');
    });
});
