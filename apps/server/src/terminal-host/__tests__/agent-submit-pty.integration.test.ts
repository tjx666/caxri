import { Buffer } from 'node:buffer';
import process from 'node:process';

import type { TerminalRecord } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import * as pty from 'node-pty';
import { describe, expect, it, vi } from 'vitest';

import { TerminalExecutionEngine } from '../engine/engine';
import type { TerminalHostMessage, TerminalHostRequestEnvelope } from '../protocol';
import { TERMINAL_HOST_PROTOCOL_VERSION } from '../protocol';
import { TerminalHostRuntime } from '../runtime';

const credential = 'a'.repeat(64);
const bootId = 'b'.repeat(32);
const terminal: TerminalRecord = {
    id: 'agent-submit-pty',
    sessionId: 'agent-submit-session',
    cwd: process.cwd(),
    kind: 'codex',
    provider: 'codex',
    title: 'Fake Agent',
    orderIndex: 0,
    lastProcessState: 'running',
    createdAt: 1,
    updatedAt: 1,
};

const fixtureProgram = String.raw`// 用真实 PTY 验证多行中文在粘贴结束后由独立回车提交
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
let pending = '';
process.stdin.on('data', (chunk) => {
  pending += chunk;
  const start = pending.indexOf('\x1b[200~');
  const end = pending.indexOf('\x1b[201~', start + 6);
  if (start < 0 || end < 0 || pending[end + 6] !== '\r') return;
  const text = pending.slice(start + 6, end);
  process.stdout.write('FAKE_AGENT_RECEIVED:' + Buffer.from(text).toString('base64') + '\r\n');
  pending = pending.slice(end + 7);
});
process.stdout.write('FAKE_AGENT_READY\r\n');
`;

function request(
    id: string,
    method: TerminalHostRequestEnvelope['request'],
    capability: TerminalHostRequestEnvelope['scope']['capability'],
): TerminalHostRequestEnvelope {
    return {
        type: 'request',
        protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
        id,
        credential,
        bootId,
        scope: {
            scope: 'terminal',
            capability,
            sessionId: terminal.sessionId,
            terminalId: terminal.id,
            ptyGeneration: 1,
        },
        request: method,
    };
}

describe('Terminal Host Agent submission over a real PTY', () => {
    it('settles an in-flight PTY write when the process closes', async () => {
        let child: pty.IPty | undefined;
        const engine = new TerminalExecutionEngine({
            emit: () => {},
            logger: { write: vi.fn(), recordMetric: vi.fn() } as unknown as StructuredLogger,
            onExit: () => {},
            spawn: (file, arguments_, options) => {
                child = pty.spawn(file, arguments_, options);
                return child;
            },
        });
        engine.start({
            record: terminal,
            executable: process.execPath,
            args: [
                '-e',
                String.raw`process.stdin.setRawMode(true); process.stdout.write('READY\n'); setInterval(() => {}, 1000)`,
            ],
            environment: { TERM: 'xterm-256color' },
            initialSnapshot: '',
        });
        const exited = new Promise<void>((resolve) => child!.onExit(() => resolve()));
        try {
            await new Promise<void>((resolve) => {
                const disposable = child!.onData((data) => {
                    if (!data.includes('READY')) return;
                    disposable.dispose();
                    resolve();
                });
            });
            const pending = engine.writeWithCompletion(terminal.id, 'x'.repeat(8 * 1024 * 1024));
            engine.close(terminal.id);
            await expect(pending).resolves.toBe(false);
        } finally {
            engine.close(terminal.id);
            await exited;
        }
    });

    it('delivers one Unicode multiline bracketed paste followed by Enter and fences a retired Agent', async () => {
        const messages: TerminalHostMessage[] = [];
        const exits: Array<Promise<void>> = [];
        const runtime = new TerminalHostRuntime({
            appVersion: '0.0.18',
            bootId,
            buildId: 'test-build',
            commit: 'deadbeef',
            credential,
            logger: { write: vi.fn(), recordMetric: vi.fn() } as unknown as StructuredLogger,
            agentLauncher: {
                cancel: vi.fn(() => Promise.resolve(true)),
                close: vi.fn(() => Promise.resolve()),
                prepare: vi.fn(() => ({
                    environment: {
                        CAXRI_AGENT_LAUNCHER_RUNTIME: '/runtime/node',
                        CAXRI_AGENT_LAUNCHER_ENTRY: '/bundle/agent-launcher.js',
                        CAXRI_AGENT_LAUNCHER_SOCKET: '/tmp/agent-launcher.sock',
                        CAXRI_AGENT_LAUNCHER_ID: 'launch-1',
                        CAXRI_AGENT_LAUNCHER_TOKEN: 'fixture-token',
                    },
                    started: Promise.resolve(123),
                })),
                signalExact: vi.fn(() => true),
                isRunningExact: vi.fn(() => true),
            },
            send: (message) => messages.push(message),
            spawn: (file, arguments_, options) => {
                const child = pty.spawn(file, arguments_, options);
                exits.push(new Promise((resolve) => child.onExit(() => resolve())));
                return child;
            },
        });
        await runtime.accept(
            request(
                'reserve',
                { method: 'terminal.reserve', params: terminal },
                'terminal.lifecycle',
            ),
        );
        await runtime.accept(
            request(
                'start',
                {
                    method: 'terminal.start',
                    params: {
                        record: terminal,
                        executable: process.execPath,
                        args: ['-e', fixtureProgram],
                        environment: { TERM: 'xterm-256color' },
                        agent: {
                            launchId: 'launch-1',
                            provider: 'codex',
                            executable: process.execPath,
                            args: [],
                            environment: {},
                        },
                    },
                },
                'terminal.lifecycle',
            ),
        );
        const started = messages.find(
            (message) => message.type === 'reply' && message.id === 'start',
        );
        expect(started).toMatchObject({ ok: true });
        const processId = (started as { result: { processId: number } }).result.processId;
        runtime.projectManagedAgentEvent({
            type: 'started',
            terminalId: terminal.id,
            launchId: 'launch-1',
            processId,
        });
        try {
            await runtime.accept(
                request(
                    'observe',
                    { method: 'terminal.observe', params: { observerId: 'observer-1' } },
                    'terminal.observe',
                ),
            );
            await expect
                .poll(() =>
                    messages
                        .filter(
                            (message) =>
                                message.type === 'event' &&
                                message.event === 'terminal.observer.output',
                        )
                        .map((message) => message.data)
                        .join(''),
                )
                .toContain('FAKE_AGENT_READY');

            const text = '请检查\n第二行：中文';
            await runtime.accept(
                request(
                    'submit',
                    { method: 'terminal.agent.submit', params: { launchId: 'launch-1', text } },
                    'terminal.agent.input',
                ),
            );
            expect(
                messages.find((message) => message.type === 'reply' && message.id === 'submit'),
            ).toMatchObject({ ok: true, result: { outcome: 'accepted' } });
            await expect
                .poll(() =>
                    messages
                        .filter(
                            (message) =>
                                message.type === 'event' &&
                                message.event === 'terminal.observer.output',
                        )
                        .map((message) => message.data)
                        .join(''),
                )
                .toContain(`FAKE_AGENT_RECEIVED:${Buffer.from(text).toString('base64')}`);

            runtime.projectManagedAgentEvent({
                type: 'exited',
                terminalId: terminal.id,
                launchId: 'launch-1',
                exitCode: 0,
                signal: null,
            });
            await runtime.accept(
                request(
                    'after-exit',
                    {
                        method: 'terminal.agent.submit',
                        params: { launchId: 'launch-1', text: 'do not send' },
                    },
                    'terminal.agent.input',
                ),
            );
            expect(
                messages.find((message) => message.type === 'reply' && message.id === 'after-exit'),
            ).toMatchObject({ ok: false, error: { code: 'CAPABILITY_DENIED' } });
        } finally {
            await runtime.accept(
                request(
                    'stop',
                    { method: 'terminal.stop', params: { persistSnapshot: false } },
                    'terminal.lifecycle',
                ),
            );
            await Promise.all(exits);
        }
    });
});
