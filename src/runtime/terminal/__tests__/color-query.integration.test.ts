import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StructuredLogger } from '../../../shared/node/logger';
import { CaxriDatabase } from '../../db/repository';
import { TerminalManager } from '..';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map(async (directory) => {
            try {
                await rm(directory, { recursive: true, force: true });
            } catch {
                // best-effort cleanup
            }
        }),
    );
});

/**
 * Minimal PTY double exposing `write` as a standalone spy so assertions stay bound-method safe.
 */
function createFakePty() {
    let onData: ((data: string) => void) | undefined;
    const write = vi.fn<(data: string) => void>();
    const process = {
        cols: 100,
        rows: 30,
        kill: vi.fn(),
        resize: vi.fn(),
        onData: (listener: (data: string) => void) => {
            onData = listener;
            return { dispose: vi.fn() };
        },
        onExit: () => ({ dispose: vi.fn() }),
        write,
    } as unknown as IPty;
    return { emitData: (data: string) => onData?.(data), process, write };
}

describe('TerminalManager color-query replies', () => {
    it('answers OSC 10/11 with theme colors and keeps the queries out of the stream', async () => {
        vi.useFakeTimers();
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-color-query-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const fake = createFakePty();
        let output = '';
        const manager = new TerminalManager(
            database,
            (event) => {
                if (event.event === 'terminal.output') output += event.payload.data;
            },
            new StructuredLogger(join(directory, 'logs')),
            {
                resolveExecutable: () => Promise.resolve('/bin/codex'),
                spawn: () => fake.process,
                terminalColors: () => ({ background: '#282a36', foreground: '#f8f8f2' }),
            },
        );

        try {
            await manager.start(created.terminal!);
            await manager.attach(created.terminal!.id);
            /**
             * The exact probe Codex sends at TUI startup (see codex-rs `terminal_probe.rs`).
             */
            fake.emitData('boot\u{1B}]10;?\u{1B}\\\u{1B}]11;?\u{1B}\\ready');
            await vi.advanceTimersByTimeAsync(50);

            expect(fake.write).toHaveBeenCalledWith('\u{1B}]10;rgb:f8f8/f8f8/f2f2\u{1B}\\');
            expect(fake.write).toHaveBeenCalledWith('\u{1B}]11;rgb:2828/2a2a/3636\u{1B}\\');
            expect(output).toBe('bootready');
            expect((await manager.snapshot(created.terminal!.id))?.payload).toBe('bootready');
        } finally {
            manager.close(created.terminal!.id);
            database.close();
            vi.useRealTimers();
        }
    });
});
