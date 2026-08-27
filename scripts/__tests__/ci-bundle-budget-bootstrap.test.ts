import { describe, expect, it, vi } from 'vitest';

vi.mock('../../apps/server/scripts/artifact', () => {
    throw new Error('Server artifact verifier loaded before the bundle build');
});

describe('ci-bundle-budget bootstrap', () => {
    it('loads before generated Server workspace dependencies exist', async () => {
        await expect(import('../ci-bundle-budget')).resolves.toBeDefined();
    });
});
