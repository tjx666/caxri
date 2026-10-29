import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runServerDatabase as runServerDatabase } from './run-server-database';

describe('runServerDatabase', () => {
    it('seeds the Bot Inbox through the Bun child where the Server migration manifest loads', async () => {
        const userData = await mkdtemp(join(tmpdir(), 'caxri-server-database-test-'));
        try {
            const ids = await runServerDatabase<{ readId: string; unreadId: string }>(
                'bot-inbox-seed',
                {
                    userData,
                },
            );
            expect(ids.readId).not.toBe(ids.unreadId);
        } finally {
            await rm(userData, { force: true, recursive: true });
        }
    });

    it('keeps Server database modules out of Playwright-loaded scenarios', async () => {
        // Playwright cannot load the manifest's `.sql?raw` imports; scenarios must go through runServerDatabase.
        const files = (await readdir(import.meta.dirname)).filter(
            (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
        );
        for (const name of files) {
            // eslint-disable-next-line no-await-in-loop -- sequential reads keep the failure message deterministic.
            const source = await readFile(join(import.meta.dirname, name), 'utf8');
            expect(source, name).not.toMatch(/import\([^)]*apps\/server\/src\/domains\/db/);
            expect(source, name).not.toMatch(/from '[^']*apps\/server\/src\/domains\/db/);
        }
    });
});
