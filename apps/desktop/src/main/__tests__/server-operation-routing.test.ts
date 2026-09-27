import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isCaxriMethod, isDesktopServerOperation } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

const MAIN_DIRECTORY = join(import.meta.dirname, '..');

async function mainSourceFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
        entries.map(async (entry): Promise<string[]> => {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) return entry.name === '__tests__' ? [] : mainSourceFiles(path);
            return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
        }),
    );
    return nested.flat();
}

describe('Desktop Main Server operation routing', () => {
    /**
     * `DesktopServerConnection.request` rejects an internal-only method before it reaches the wire unless the method is
     * in `desktopServerOperationIds`, and unit tests inject their own request fakes, so a missing entry only shows up
     * as a silently failing feature in the running app.
     */
    it('lists every internal-only method Main requests in the Desktop-authenticated allowlist', async () => {
        const files = await mainSourceFiles(MAIN_DIRECTORY);
        const sources = await Promise.all(files.map((file) => readFile(file, 'utf8')));
        const requested = new Set(
            sources.flatMap((source) =>
                Array.from(source.matchAll(/\.request\(\s*'([\w.]+)'/gu), (match) => match[1]),
            ),
        );
        expect(requested).toContain('agent.replySummary');
        const unreachable = [...requested].filter(
            (method) => !isCaxriMethod(method) && !isDesktopServerOperation(method),
        );
        expect(unreachable).toEqual([]);
    });
});
