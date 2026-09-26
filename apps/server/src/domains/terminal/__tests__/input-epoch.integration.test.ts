import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { expect, it, vi } from 'vitest';

import { LocalTerminalExecution } from '../../../__tests__/support/local-terminal-execution';
import { createTestTerminalManager } from '../../../__tests__/support/terminal';
import { CaxriDatabase } from '../../db';

it('retains draft-input ownership while excluding native protocol replies and internal task submission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-input-epoch-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const logger = new StructuredLogger(join(directory, 'logs'));
    const onInput = vi.fn();
    const manager = createTestTerminalManager(database, () => {}, logger, { onInput });
    try {
        const id = database.createSession(database.createProject(directory).id, 'shell').terminal!
            .id;
        manager.write(id, '\u{1B}[?1;2c');
        manager.writeAgentExact(
            id,
            '\u{1B}[200~Synthetic pointer\u{1B}[201~\r',
            'launch',
            'delegation',
        );
        expect(manager.inputEpoch(id)).toBe(0);
        expect(onInput).not.toHaveBeenCalled();
        manager.write(id, 'Unsubmitted synthetic draft');
        expect(manager.inputEpoch(id)).toBe(1);
        expect(onInput).toHaveBeenCalledWith(id, 'Unsubmitted synthetic draft');
        manager.writeAgentExact(id, '\u{1B}', 'launch');
        expect(manager.inputEpoch(id)).toBe(2);
    } finally {
        await manager.shutdown('terminate');
        database.close();
        await logger.flush();
        await rm(directory, { recursive: true, force: true });
    }
});

it('retires terminal view state when terminating a session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-terminal-retirement-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const logger = new StructuredLogger(join(directory, 'logs'));
    const manager = createTestTerminalManager(database, () => {}, logger);
    const project = database.createProject(directory);
    const session = database.createSession(project.id, 'shell');

    try {
        const terminalId = session.terminal!.id;
        manager.write(terminalId, 'draft');
        await manager.attach(terminalId, { cols: 120, rows: 40 });
        expect(manager.inputEpoch(terminalId)).toBe(1);
        expect(manager.dimensions(terminalId)).toEqual({ cols: 120, rows: 40 });

        manager.terminateSession(session.session.id);

        expect(manager.inputEpoch(terminalId)).toBe(0);
        expect(manager.dimensions(terminalId)).toBeUndefined();

        const freshSession = database.createSession(project.id, 'shell');
        const freshTerminalId = freshSession.terminal!.id;
        manager.write(freshTerminalId, 'fresh draft');
        await manager.attach(freshTerminalId, { cols: 80, rows: 24 });
        expect(manager.inputEpoch(freshTerminalId)).toBe(1);
        expect(manager.dimensions(freshTerminalId)).toEqual({ cols: 80, rows: 24 });
    } finally {
        await manager.shutdown('terminate');
        database.close();
        await logger.flush();
        await rm(directory, { recursive: true, force: true });
    }
});

it('does not resurrect view state when an attach completes after session deletion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-terminal-late-attach-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const logger = new StructuredLogger(join(directory, 'logs'));
    const execution = new LocalTerminalExecution({ logger });
    const attach = Promise.withResolvers<{ snapshot: null; wasAttached: boolean }>();
    const attachRequest = vi.spyOn(execution, 'attach').mockReturnValue(attach.promise);
    const manager = createTestTerminalManager(database, () => {}, logger, { execution });
    const project = database.createProject(directory);
    const session = database.createSession(project.id, 'shell');

    try {
        const terminalId = session.terminal!.id;
        const attaching = manager.attach(terminalId, { cols: 120, rows: 40 });
        expect(attachRequest).toHaveBeenCalledWith(terminalId, { cols: 120, rows: 40 });

        manager.terminateSession(session.session.id);
        database.deleteSession(session.session.id);
        attach.resolve({ snapshot: null, wasAttached: false });
        await attaching;

        expect(manager.dimensions(terminalId)).toBeUndefined();
    } finally {
        await manager.shutdown('terminate');
        database.close();
        await logger.flush();
        await rm(directory, { recursive: true, force: true });
    }
});
