import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TerminalRecord, TerminalSnapshot } from '@caxri/protocol';
import type { ObservationContext } from '@caxri/system';
import { StructuredLogger } from '@caxri/system';
import { vi } from 'vitest';

import type { TerminalExecutionStart } from '../engine/engine';
import type { TerminalHostMessage, TerminalHostRequestEnvelope } from '../protocol';
import { TERMINAL_HOST_PROTOCOL_VERSION, terminalHostRequestEnvelopeSchema } from '../protocol';
import type { ManagedAgentExecutionOwner, TerminalExecutionOwner } from '../runtime';
import { TerminalHostRuntime } from '../runtime';

const credential = 'a'.repeat(64);
const bootId = 'b'.repeat(32);
export const terminal: TerminalRecord = {
    id: 'terminal-1',
    sessionId: 'session-1',
    cwd: '/project',
    kind: 'shell',
    title: 'Shell',
    orderIndex: 0,
    lastProcessState: 'starting',
    createdAt: 1,
    updatedAt: 1,
};
const temporaryDirectories: string[] = [];
const loggers: StructuredLogger[] = [];

export function privateRequest(
    request: TerminalHostRequestEnvelope['request'],
    scope: TerminalHostRequestEnvelope['scope'],
    id: string,
    observation?: ObservationContext,
): TerminalHostRequestEnvelope {
    return terminalHostRequestEnvelopeSchema.parse({
        type: 'request',
        protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
        id,
        ...(observation && { observation }),
        bootId,
        credential,
        scope,
        request,
    });
}

export const emptySnapshot: TerminalSnapshot = {
    terminalId: terminal.id,
    encodingVersion: 1,
    cols: 80,
    rows: 24,
    lineCount: 0,
    byteCount: 0,
    payload: '',
    updatedAt: 1,
};

export function fakeEngine() {
    const attach = vi.fn(() => Promise.resolve({ snapshot: null, wasAttached: false }));
    const snapshot = vi.fn(() => Promise.resolve(null));
    const start = vi.fn<(input: TerminalExecutionStart) => number>(() => 42);
    const write = vi.fn(() => true);
    const writeWithCompletion = vi.fn(() => Promise.resolve(true));
    return {
        attach,
        snapshot,
        start,
        write,
        writeWithCompletion,
        owner: {
            attach,
            close: vi.fn<TerminalExecutionOwner['close']>(),
            detachAllViews: vi.fn<TerminalExecutionOwner['detachAllViews']>(),
            detachView: vi.fn<TerminalExecutionOwner['detachView']>(),
            observe: vi.fn(() => Promise.resolve({ snapshot: emptySnapshot, nextSequence: 0 })),
            unobserve: vi.fn<TerminalExecutionOwner['unobserve']>(),
            takeOver: vi.fn(() => ({ expiresAt: Date.now() + 12_000 })),
            renewTakeOver: vi.fn(() => ({ expiresAt: Date.now() + 12_000 })),
            releaseTakeOver: vi.fn<TerminalExecutionOwner['releaseTakeOver']>(),
            processId: vi.fn(() => 42),
            reassignSession: vi.fn<TerminalExecutionOwner['reassignSession']>(),
            reconcileOutputRecoverySettings:
                vi.fn<TerminalExecutionOwner['reconcileOutputRecoverySettings']>(),
            resize: vi.fn(() => true),
            resources: vi.fn(() => Promise.resolve(null)),
            restartBarrier: vi.fn<TerminalExecutionOwner['restartBarrier']>(),
            runningCount: vi.fn(() => 1),
            scroll: vi.fn(() => true),
            shutdown: vi.fn<TerminalExecutionOwner['shutdown']>(() => []),
            signalExact: vi.fn(() => true),
            snapshot,
            start,
            waitForAttachedSize: vi.fn(async () => {}),
            write,
            writeWithCompletion,
        },
    };
}

/**
 * Managed Agent launcher double. Tests hold `cancel` open to reproduce the wait that `terminal.stop`,
 * `terminal.retire`, and a failed `terminal.start` spend on Agent cancellation.
 */
export function fakeAgentLauncher() {
    const cancel = vi.fn<ManagedAgentExecutionOwner['cancel']>(() => Promise.resolve(true));
    const prepare = vi.fn<ManagedAgentExecutionOwner['prepare']>(({ launchId }) => ({
        environment: {
            CAXRI_AGENT_LAUNCHER_RUNTIME: '/runtime/node',
            CAXRI_AGENT_LAUNCHER_ENTRY: '/bundles/agent-launcher.js',
            CAXRI_AGENT_LAUNCHER_SOCKET: '/tmp/agent.sock',
            CAXRI_AGENT_LAUNCHER_ID: launchId,
            CAXRI_AGENT_LAUNCHER_TOKEN: 'one-time-token',
        },
        started: Promise.resolve(101),
    }));
    const signalExact = vi.fn<ManagedAgentExecutionOwner['signalExact']>(() => true);
    return {
        cancel,
        prepare,
        signalExact,
        owner: {
            cancel,
            close: vi.fn(() => Promise.resolve()),
            isRunningExact: vi.fn(() => true),
            prepare,
            signalExact,
        } satisfies ManagedAgentExecutionOwner,
    };
}

/**
 * The `terminal.start` Server Core sends for a managed Agent launch of `launchId`.
 */
export function startAgentLaunch(
    runtime: TerminalHostRuntime,
    ptyGeneration: number,
    id: string,
    launchId = 'launch-1',
    record: TerminalRecord = terminal,
): Promise<void> {
    return runtime.accept(
        privateRequest(
            {
                method: 'terminal.start',
                params: {
                    record,
                    executable: '/bin/zsh',
                    args: [],
                    environment: {},
                    agent: {
                        launchId,
                        provider: 'codex',
                        executable: '/usr/local/bin/codex',
                        args: [],
                        environment: {},
                    },
                },
            },
            lifecycleScope(ptyGeneration, record.id),
            id,
        ),
    );
}

export function createRuntime(
    engine: TerminalExecutionOwner,
    agentLauncher?: ManagedAgentExecutionOwner,
): {
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
    loggers.push(logger);
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
            agentLauncher,
            engine,
            logger,
            onProtocolViolation: protocolViolation,
            send: (message) => messages.push(message),
        }),
    };
}

/**
 * Lifecycle scope Server Core uses for `terminal.reserve`, `terminal.start`, and `terminal.stop` of one generation.
 */
export function lifecycleScope(ptyGeneration = 1, terminalId = terminal.id) {
    return {
        scope: 'terminal',
        capability: 'terminal.lifecycle',
        sessionId: terminal.sessionId,
        terminalId,
        ptyGeneration,
    } as const;
}

/**
 * Sends the `terminal.reserve` Server Core issues before every `terminal.start` on the same Host boot; the Host rejects
 * a start no reservation covers.
 */
export function reserveLaunch(
    runtime: TerminalHostRuntime,
    scope: { ptyGeneration: number; terminalId: string },
    record: TerminalRecord = terminal,
): Promise<void> {
    return runtime.accept(
        privateRequest(
            { method: 'terminal.reserve', params: record },
            lifecycleScope(scope.ptyGeneration, scope.terminalId),
            `reserve-${scope.terminalId}-${scope.ptyGeneration}`,
        ),
    );
}

/**
 * Awaits the async log writers before deleting their directories, which otherwise races with log creation in CI.
 */
export async function cleanupRuntimeFixtures(): Promise<void> {
    await Promise.all(loggers.map((logger) => logger.flush()));
    loggers.length = 0;
    for (const directory of temporaryDirectories)
        rmSync(directory, { force: true, recursive: true });
    temporaryDirectories.length = 0;
}
