import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const receiptsPath = fileURLToPath(
    new URL('../../../../../../docs/agent-dispatch-receipts.md', import.meta.url),
);

describe('dispatch-shutdown-documentation-parity', () => {
    it('distinguishes Terminal closure, orderly shutdown, and Core reset', async () => {
        const body = await readFile(receiptsPath, 'utf8');

        expect(body).toMatch(/Explicit Terminal closure[\s\S]{1,200}intentional `stopped` outcome/);
        expect(body).toMatch(/Orderly Server shutdown[\s\S]{1,80}`interrupted`/);
        expect(body).toMatch(/`failed` with `host_reset`/);
        expect(body).not.toMatch(
            /orderly Server shutdown retain(?:s| their) (?:their )?intentional stopped outcome/i,
        );
    });
});
