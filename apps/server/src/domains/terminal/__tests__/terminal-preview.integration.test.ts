import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import type { IPty } from 'node-pty';
import { expect, it } from 'vitest';

import { createTestTerminalManager } from '../../../__tests__/support/terminal';
import { CaxriDatabase } from '../../db/repository';

const createPreviewPty = (): { emitData: (data: string) => void; process: IPty } => {
    let onData: ((data: string) => void) | undefined;
    const process = {
        kill: () => {},
        onData: (listener: (data: string) => void) => {
            onData = listener;
            return { dispose: () => {} };
        },
        onExit: () => ({ dispose: () => {} }),
        pid: 7_777,
        resize: () => {},
        write: () => {},
    } as unknown as IPty;
    return { emitData: (data) => onData?.(data), process };
};

it('returns a bounded plain-text live preview and distinguishes a stopped Terminal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-preview-'));
    const logger = new StructuredLogger(join(directory, 'logs'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const project = database.createProject(directory);
    const live = database.createSession(project.id, 'codex');
    const stopped = database.createSession(project.id, 'shell');
    const fake = createPreviewPty();
    const manager = createTestTerminalManager(database, () => {}, logger, {
        resolveExecutable: (kind) => Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/bin/echo'),
        spawn: () => fake.process,
    });

    try {
        await manager.start(live.terminal!);
        fake.emitData(`\u{1B}[31mVISIBLE\u{1B}[0m${'界'.repeat(6_000)}`);
        const preview = await manager.preview(live.terminal!.id);
        expect(preview).toMatchObject({ availability: 'live', truncated: true });
        expect(preview.content).toContain('界');
        expect(preview.content).not.toContain('\u{1B}');
        expect(new TextEncoder().encode(preview.content).byteLength).toBeLessThanOrEqual(
            16 * 1_024,
        );
        await expect(manager.preview(stopped.terminal!.id)).resolves.toMatchObject({
            availability: 'stopped',
            content: '',
            truncated: false,
        });
    } finally {
        manager.close(live.terminal!.id);
        database.close();
        await logger.flush();
        await rm(directory, { recursive: true, force: true });
    }
});
