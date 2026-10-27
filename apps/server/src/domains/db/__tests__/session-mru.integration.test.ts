import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CaxriDatabase } from '../repository';

describe('Session MRU persistence', () => {
    it('persists strict order when selections share one wall-clock millisecond', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-db-session-mru-clock-'));
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(projectRoot);
        const first = database.createSession(project.id, 'shell').session;
        const second = database.createSession(project.id, 'shell').session;
        const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);

        try {
            database.selectSession(first.id);
            const firstOpenedAt = database.getSession(first.id)!.lastVisitedAt;
            database.selectSession(second.id);
            const secondOpenedAt = database.getSession(second.id)!.lastVisitedAt;
            database.selectSession(first.id);
            const reopenedAt = database.getSession(first.id)!.lastVisitedAt;

            expect(secondOpenedAt).toBeGreaterThan(firstOpenedAt);
            expect(reopenedAt).toBeGreaterThan(secondOpenedAt);
        } finally {
            clock.mockRestore();
            database.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
});
