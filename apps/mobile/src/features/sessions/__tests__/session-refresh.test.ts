import { describe, expect, it, vi } from 'vitest';

import { loadMobileSessionSections } from '../session-refresh';

describe('loadMobileSessionSections', () => {
    it('preserves the last valid screen when one polling request fails', async () => {
        const unavailable = vi.fn(() => Promise.reject(new Error('offline')));

        await expect(
            loadMobileSessionSections({
                dashboard: unavailable,
            }),
        ).resolves.toBeNull();
        expect(unavailable).toHaveBeenCalledOnce();
    });
});
