import { afterEach, describe, expect, it } from 'vitest';

import { useFileClipboardStore } from '../file-clipboard';

afterEach(() => useFileClipboardStore.getState().clear());

describe('file clipboard', () => {
    it('retains only bounded copy or cut metadata and can be consumed explicitly', () => {
        useFileClipboardStore.getState().set({
            mode: 'cut',
            path: '/project/source.txt',
            sessionId: 'session-1',
        });
        expect(useFileClipboardStore.getState().entry).toEqual({
            mode: 'cut',
            path: '/project/source.txt',
            sessionId: 'session-1',
        });

        useFileClipboardStore.getState().clear();
        expect(useFileClipboardStore.getState().entry).toBeUndefined();
    });
});
