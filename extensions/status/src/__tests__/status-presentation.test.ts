import { describe, expect, it } from 'vitest';

import { pullRequestCheckIcon } from '../status-presentation';

describe('pullRequestCheckIcon', () => {
    it.each([
        ['open', 'circle-check'],
        ['draft', 'circle-check'],
        ['closed', 'circle-check'],
        [undefined, 'circle-check'],
        // Merged checks are settled history, so only that lifecycle trades the green success tone for violet.
        ['merged', 'circle-check-merged'],
    ] as const)('gives passing checks on a %s pull request %s', (lifecycle, icon) => {
        expect(pullRequestCheckIcon({ lifecycle, state: 'success' })).toBe(icon);
    });

    it.each([
        ['failure', 'circle-x'],
        ['pending', 'loading'],
        ['queued', 'circle-small-filled'],
    ] as const)('keeps a merged pull request with %s checks on the shared glyph', (state, icon) => {
        expect(pullRequestCheckIcon({ lifecycle: 'merged', state })).toBe(icon);
    });
});
