import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeEvent } from '../../../shared/ipc';
import { StructuredLogger } from '../../../shared/node/logger';
import { CaxriDatabase } from '../../db/repository';
import { TerminalManager } from '..';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

describe('TerminalManager process integration', () => {
    it('spawns a real PTY, accepts input, emits output, persists a snapshot, and exits', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
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
        await Promise.all([manager.start(created.terminal!), manager.start(created.terminal!)]);
        await manager.attach(created.terminal!.id);
        manager.write(created.terminal!.id, "printf 'CAXRI_INTEGRATION_OK\\n'\r");
        await marker;
        manager.resize(created.terminal!.id, 120, 40);
        manager.write(created.terminal!.id, 'exit\r');
        await exited;
        expect(events.some((event) => event.event === 'terminal.output')).toBe(true);
        expect(database.getSnapshot(created.terminal!.id)?.payload).toContain(
            'CAXRI_INTEGRATION_OK',
        );
        // The logger now drains writes asynchronously, so poll the log file instead of reading
        // it once: the `pty.spawned`/`pty.throughput` records may not be flushed to disk yet.
        await vi.waitFor(async () => {
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
        });
        database.close();
    });

    it('restarts a live PTY under the same durable terminal and closes it without late database writes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-restart-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        let output = '';
        const manager = new TerminalManager(
            database,
            (event) => {
                if (event.event === 'terminal.output') output += event.payload.data;
            },
            new StructuredLogger(join(directory, 'logs')),
        );

        await manager.start(created.terminal!);
        await manager.attach(created.terminal!.id);
        await manager.restart(created.terminal!.id);
        manager.write(created.terminal!.id, "printf 'CAXRI_RESTART_OK\\n'\r");
        await expect.poll(() => output).toContain('CAXRI_RESTART_OK');
        expect(database.getTerminal(created.terminal!.id)?.lastProcessState).toBe('running');

        manager.close(created.terminal!.id);
        expect(database.getTerminal(created.terminal!.id)).toBeUndefined();
        await new Promise((resolve) => setTimeout(resolve, 100));
        database.close();
    });

    it('ignores input and resize requests that arrive after a Terminal has stopped', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-stale-input-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const manager = new TerminalManager(
            database,
            () => {},
            new StructuredLogger(join(directory, 'logs')),
        );

        expect(manager.write(created.terminal!.id, 'ignored')).toBe(false);
        expect(manager.resize(created.terminal!.id, 120, 40)).toBe(false);

        await manager.start(created.terminal!);
        expect(manager.write(created.terminal!.id, "printf 'CAXRI_LIVE_INPUT_OK\\n'\r")).toBe(true);
        expect(manager.resize(created.terminal!.id, 120, 40)).toBe(true);
        manager.shutdown('orderly');
        expect(manager.write(created.terminal!.id, 'ignored')).toBe(false);
        database.close();
    });
});
