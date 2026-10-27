import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import type { TerminalRecord } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import * as pty from 'node-pty';
import { describe, expect, it, vi } from 'vitest';

import { ShellIntegrationService } from '../../../domains/terminal/shell-integration';
import { submitAgentText } from '../../agent-submission';
import { TerminalExecutionEngine } from '../../engine/engine';
import { ManagedAgentLauncherServer } from '../server';

const execFileAsync = promisify(execFile);

function isProcessAlive(processId: number): boolean {
    try {
        process.kill(processId, 0);
        return true;
    } catch {
        return false;
    }
}

describe.runIf(process.platform === 'darwin')('managed Agent shell input drain', () => {
    it('keeps the launcher foreground when Host transport fails before exit acknowledgement', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-handoff-failure-'));
        const entryPath = join(directory, 'agent-launcher.mjs');
        const marker = join(directory, 'queued-command-ran');
        let shell: pty.IPty | undefined;
        let shellExited: Promise<void> | undefined;
        let output = '';
        const server = new ManagedAgentLauncherServer({
            socketPath: join(directory, 'agent.sock'),
            runtimePath: process.execPath,
            entryPath,
            beforeExitAck: () => ({
                ready: new Promise<void>(() => {}),
                resumeAfterDrain: () => {},
                closeOnLostDrain: () => {},
            }),
        });
        try {
            await execFileAsync('bun', [
                'build',
                resolve(import.meta.dirname, '../process.ts'),
                '--target',
                'node',
                '--outfile',
                entryPath,
            ]);
            const integration = await ShellIntegrationService.create(join(directory, 'profile'));
            await server.start();
            const prepared = server.prepare({
                terminalId: 'terminal-failure',
                launchId: 'launch-failure',
                plan: {
                    executable: process.execPath,
                    args: [
                        '-e',
                        String.raw`process.stdin.setRawMode(true); process.stdout.write('READY\n'); setInterval(() => {}, 1000)`,
                    ],
                    environment: { TERM: 'xterm-256color' },
                    cwd: directory,
                },
            });
            const launch = integration.resolve('/bin/zsh', {
                HOME: directory,
                TERM: 'xterm-256color',
                ...prepared.environment,
            });
            expect(launch).toBeDefined();
            shell = pty.spawn('/bin/zsh', launch!.args, {
                cwd: directory,
                env: launch!.environment,
                cols: 80,
                rows: 24,
            });
            shellExited = new Promise((resolve) => shell!.onExit(() => resolve()));
            shell.onData((data) => {
                output += data;
            });
            const agentProcessId = await prepared.started;
            await expect.poll(() => output.includes('READY')).toBe(true);
            shell.write(`\u{1B}[200~/usr/bin/touch ${marker}\u{1B}[201~\r`);
            const sockets = Reflect.get(server, 'sockets') as Set<Socket>;
            for (const socket of sockets) socket.destroy();
            // Losing the Host transport makes the launcher fail closed and stop the Agent itself (`failClosed` in
            // `client.ts`). Signalling the Agent here as well raced that stop: once the child was reaped, `kill` threw
            // ESRCH (#2437).
            await expect.poll(() => isProcessAlive(agentProcessId)).toBe(false);
            await expect
                .poll(() => server.isRunningExact('terminal-failure', 'launch-failure'))
                .toBe(false);
            await expect.poll(() => output.includes('Agent input handoff failed')).toBe(true);
            expect(output).not.toContain('\u{1B}]133;A\u{7}');
            expect(existsSync(marker)).toBe(false);
        } finally {
            if (shell) (shell as pty.IPty & { destroy?: () => void }).destroy?.();
            if (shellExited) await shellExited;
            await server.close();
            await rm(directory, { force: true, recursive: true });
        }
    }, 20_000);

    it.each(['/bin/zsh', '/bin/bash'])(
        'does not run queued Agent input in %s after Agent exit',
        async (shellExecutable) => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-drain-'));
            const entryPath = join(directory, 'agent-launcher.mjs');
            const queuedCommandMarker = join(directory, 'queued-command-ran');
            const normalCommandMarker = join(directory, 'normal-command-ran');
            let shell: pty.IPty | undefined;
            let shellExited: Promise<void> | undefined;
            let output = '';
            const engine = new TerminalExecutionEngine({
                emit: () => {},
                logger: { write: vi.fn(), recordMetric: vi.fn() } as unknown as StructuredLogger,
                onExit: () => {},
                spawn: (file, arguments_, options) => {
                    const child = pty.spawn(file, arguments_, options);
                    shell = child;
                    shellExited = new Promise((resolve) => child.onExit(() => resolve()));
                    child.onData((data) => {
                        output += data;
                    });
                    return child;
                },
            });
            const server = new ManagedAgentLauncherServer({
                socketPath: join(directory, 'agent.sock'),
                runtimePath: process.execPath,
                entryPath,
                beforeExitAck: (terminalId) => engine.quiesceInput(terminalId),
            });
            try {
                await execFileAsync('bun', [
                    'build',
                    resolve(import.meta.dirname, '../process.ts'),
                    '--target',
                    'node',
                    '--outfile',
                    entryPath,
                ]);
                const integration = await ShellIntegrationService.create(
                    join(directory, 'profile'),
                );
                await server.start();
                const prepared = server.prepare({
                    terminalId: 'terminal-1',
                    launchId: 'launch-1',
                    plan: {
                        executable: process.execPath,
                        args: [
                            '-e',
                            String.raw`process.stdin.setRawMode(true); process.stdout.write("FAKE_AGENT_READY\n"); setInterval(() => {}, 1000)`,
                        ],
                        environment: { TERM: 'xterm-256color' },
                        cwd: directory,
                    },
                });
                const launch = integration.resolve(shellExecutable, {
                    HOME: directory,
                    TERM: 'xterm-256color',
                    ...prepared.environment,
                });
                expect(launch).toBeDefined();
                const record: TerminalRecord = {
                    id: 'terminal-1',
                    sessionId: 'session-1',
                    cwd: directory,
                    kind: 'shell',
                    title: 'Shell',
                    orderIndex: 0,
                    lastProcessState: 'running',
                    createdAt: 1,
                    updatedAt: 1,
                };
                engine.start({
                    record,
                    executable: shellExecutable,
                    args: launch!.args,
                    environment: launch!.environment,
                    initialSnapshot: '',
                    initialSize: { cols: 80, rows: 24 },
                });
                const agentProcessId = await prepared.started;
                expect(server.isRunningExact('terminal-1', 'launch-1')).toBe(true);
                await expect.poll(() => output.includes('FAKE_AGENT_READY')).toBe(true);
                expect(engine.write('terminal-1', 'x'.repeat(8 * 1024 * 1024))).toBe(true);
                const text = `${'x'.repeat(16_000)}\n/usr/bin/touch ${queuedCommandMarker}`;
                expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(16 * 1024);
                const submissionPromise = submitAgentText(
                    engine,
                    { running: true, agentLaunchId: 'launch-1', agentProcessId },
                    'terminal-1',
                    'launch-1',
                    text,
                    () => server.isRunningExact('terminal-1', 'launch-1'),
                );
                process.kill(agentProcessId, 'SIGTERM');
                const submission = await submissionPromise;
                expect(['accepted', 'unknown']).toContain(submission.outcome);

                await expect
                    .poll(() => server.isRunningExact('terminal-1', 'launch-1'))
                    .toBe(false);
                await expect.poll(() => output.includes('\u{1B}]133;A\u{7}')).toBe(true);
                expect(existsSync(queuedCommandMarker)).toBe(false);
                expect(output).not.toContain(queuedCommandMarker);

                await expect
                    .poll(() =>
                        engine.write('terminal-1', `/usr/bin/touch ${normalCommandMarker}\r`),
                    )
                    .toBe(true);
                await expect.poll(() => existsSync(normalCommandMarker)).toBe(true);
                expect(existsSync(queuedCommandMarker)).toBe(false);
            } finally {
                shell?.kill();
                if (shellExited) await shellExited;
                await server.close();
                await rm(directory, { force: true, recursive: true });
            }
        },
        20_000,
    );
});
