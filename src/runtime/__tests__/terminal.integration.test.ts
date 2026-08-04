import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeEvent } from '../../shared/contracts';
import { CaxriDatabase } from '../database';
import { StructuredLogger } from '../logger';
import { TerminalManager } from '../terminal';

const temporaryDirectories: string[] = [];

function createFakePty() {
    let onData: ((data: string) => void) | undefined;
    const kill = vi.fn();
    const process = {
        kill,
        onData: vi.fn((listener: (data: string) => void) => {
            onData = listener;
            return { dispose: vi.fn() };
        }),
        onExit: vi.fn(() => ({ dispose: vi.fn() })),
        resize: vi.fn(),
        write: vi.fn(),
    } as unknown as IPty;
    return { emitData: (data: string) => onData?.(data), kill, process };
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('TerminalManager', () => {
    it('does not register a PTY whose durable record was closed while spawn was pending', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-pending-close-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(directory, 'shell');
        const executable = Promise.withResolvers<string>();
        const fake = createFakePty();
        const manager = new TerminalManager(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            {
                resolveExecutable: () => executable.promise,
                spawn: () => fake.process,
            },
        );

        const starting = manager.start(created.terminal);
        manager.close(created.terminal.id);
        executable.resolve('/bin/zsh');
        const result = await starting.catch((error: unknown) => error);

        try {
            expect(result).toBeInstanceOf(Error);
            expect(manager.runningCount()).toBe(0);
            expect(fake.kill).toHaveBeenCalledOnce();
        } finally {
            manager.close(created.terminal.id);
            database.close();
        }
    });

    it('does not replay queued live output after returning it in an attachment snapshot', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-attach-replay-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(directory, 'shell');
        const fake = createFakePty();
        let output = '';
        const manager = new TerminalManager(
            database,
            (event) => {
                if (event.event === 'terminal.output') output += event.payload.data;
            },
            new StructuredLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn: () => fake.process },
        );

        await manager.start(created.terminal);
        manager.attach(created.terminal.id);
        fake.emitData('queued exactly once');
        expect(manager.attach(created.terminal.id)?.payload).toContain('queued exactly once');
        await new Promise((resolve) => setTimeout(resolve, 30));

        try {
            expect(output).toBe('');
        } finally {
            manager.close(created.terminal.id);
            database.close();
        }
    });

    it('detaches every Renderer view without stopping its PTY', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-detach-all-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(directory, 'shell');
        const fake = createFakePty();
        let output = '';
        const manager = new TerminalManager(
            database,
            (event) => {
                if (event.event === 'terminal.output') output += event.payload.data;
            },
            new StructuredLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn: () => fake.process },
        );

        await manager.start(created.terminal);
        manager.attach(created.terminal.id);
        fake.emitData('discard with closing view');
        manager.detachAllViews();
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(output).toBe('');
        expect(manager.runningCount()).toBe(1);
        manager.close(created.terminal.id);
        database.close();
    });

    it('buffers detached output in the snapshot and emits only after attachment', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-detached-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(directory, 'shell');
        let output = '';
        const manager = new TerminalManager(
            database,
            (event) => {
                if (event.event === 'terminal.output') output += event.payload.data;
            },
            new StructuredLogger(join(directory, 'logs')),
        );

        await manager.start(created.terminal);
        manager.write(created.terminal.id, "printf 'DETACHED_ONLY\\n'\r");
        await expect
            .poll(() => database.getSnapshot(created.terminal.id)?.payload)
            .toContain('DETACHED_ONLY');
        expect(output).not.toContain('DETACHED_ONLY');
        expect(manager.attach(created.terminal.id)?.payload).toContain('DETACHED_ONLY');

        manager.write(created.terminal.id, "printf 'ATTACHED_OUTPUT\\n'\r");
        await expect.poll(() => output).toContain('ATTACHED_OUTPUT');
        manager.detachView(created.terminal.id);
        manager.write(created.terminal.id, "printf 'DETACHED_AGAIN\\n'\r");
        await expect
            .poll(() => database.getSnapshot(created.terminal.id)?.payload)
            .toContain('DETACHED_AGAIN');
        expect(output).not.toContain('DETACHED_AGAIN');

        manager.shutdown();
        database.close();
    });

    it('spawns a real PTY, accepts input, emits output, persists a snapshot, and exits', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(directory, 'shell');
        const events: RuntimeEvent[] = [];
        let resolveMarker: (() => void) | undefined;
        let resolveExit: (() => void) | undefined;
        const marker = new Promise<void>((resolve) => (resolveMarker = resolve));
        const exited = new Promise<void>((resolve) => (resolveExit = resolve));
        const manager = new TerminalManager(
            database,
            (event) => {
                events.push(event);
                if (
                    event.event === 'terminal.output' &&
                    event.payload.data.includes('CAXRI_INTEGRATION_OK')
                )
                    resolveMarker?.();
                if (event.event === 'terminal.exit') resolveExit?.();
            },
            new StructuredLogger(join(directory, 'logs')),
        );
        await Promise.all([manager.start(created.terminal), manager.start(created.terminal)]);
        manager.attach(created.terminal.id);
        manager.write(created.terminal.id, "printf 'CAXRI_INTEGRATION_OK\\n'\r");
        await marker;
        manager.resize(created.terminal.id, 120, 40);
        manager.write(created.terminal.id, 'exit\r');
        await exited;
        expect(events.some((event) => event.event === 'terminal.output')).toBe(true);
        expect(database.getSnapshot(created.terminal.id)?.payload).toContain(
            'CAXRI_INTEGRATION_OK',
        );
        const records = (await readFile(join(directory, 'logs', 'runtime.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map(
                (line) =>
                    JSON.parse(line) as {
                        event: string;
                        durationMs?: number;
                        fields?: { inputBytes?: number };
                    },
            );
        expect(records.filter((record) => record.event === 'pty.spawned')).toHaveLength(1);
        expect(records.find((record) => record.event === 'pty.spawned')?.durationMs).toBeTypeOf(
            'number',
        );
        expect(
            records.find((record) => record.event === 'pty.throughput')?.fields?.inputBytes,
        ).toBeGreaterThan(0);
        database.close();
    });

    it('restarts a live PTY under the same durable terminal and closes it without late database writes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-restart-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(directory, 'shell');
        let output = '';
        const manager = new TerminalManager(
            database,
            (event) => {
                if (event.event === 'terminal.output') output += event.payload.data;
            },
            new StructuredLogger(join(directory, 'logs')),
        );

        await manager.start(created.terminal);
        manager.attach(created.terminal.id);
        await manager.restart(created.terminal.id);
        manager.write(created.terminal.id, "printf 'CAXRI_RESTART_OK\\n'\r");
        await expect.poll(() => output).toContain('CAXRI_RESTART_OK');
        expect(database.getTerminal(created.terminal.id)?.lastProcessState).toBe('running');

        manager.close(created.terminal.id);
        expect(database.getTerminal(created.terminal.id)).toBeUndefined();
        await new Promise((resolve) => setTimeout(resolve, 100));
        database.close();
    });

    it('ignores input and resize requests that arrive after a Terminal has stopped', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-stale-input-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(directory, 'shell');
        const manager = new TerminalManager(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
        );

        expect(manager.write(created.terminal.id, 'ignored')).toBe(false);
        expect(manager.resize(created.terminal.id, 120, 40)).toBe(false);

        await manager.start(created.terminal);
        expect(manager.write(created.terminal.id, "printf 'CAXRI_LIVE_INPUT_OK\\n'\r")).toBe(true);
        expect(manager.resize(created.terminal.id, 120, 40)).toBe(true);
        manager.shutdown();
        expect(manager.write(created.terminal.id, 'ignored')).toBe(false);
        database.close();
    });
});
