import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

/**
 * The project search Worker cannot import `@caxri/system` (it is loaded by relative `.ts` path and its tests run the
 * TypeScript source directly as a Worker), so `read-file-handle-up-to.ts` exists as a deliberate twin. Only the doc
 * comment may differ; the executable loop must stay identical to the shared one.
 */
it('keeps the Worker copy of readFileHandleUpTo identical to the shared implementation', async () => {
    const strip = (source: string) => source.replaceAll(/\/\*\*[\s\S]*?\*\//g, '').trim();
    const server = await readFile(
        fileURLToPath(new URL('../read-file-handle-up-to.ts', import.meta.url)),
        'utf8',
    );
    const shared = await readFile(
        fileURLToPath(
            new URL(
                '../../../../../packages/system/src/filesystem/read-file-handle-up-to.ts',
                import.meta.url,
            ),
        ),
        'utf8',
    );
    expect(strip(server)).toBe(strip(shared));
});
