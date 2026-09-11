import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { expect, it, vi } from 'vitest';

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
        expect(onInput).toHaveBeenCalledWith(id);
        manager.writeAgentExact(id, '\u{1B}', 'launch');
        expect(manager.inputEpoch(id)).toBe(2);
    } finally {
        await manager.shutdown('terminate');
        database.close();
        await logger.flush();
        await rm(directory, { recursive: true, force: true });
    }
});
