import { describe, expect, it } from 'vitest';

import type { ShareRequest } from './share-request-store';
import { mergedShareRequest } from './share-request-store';

const first: ShareRequest = {
    requestId: '0f3c1d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
    files: [{ path: '/inbox/a/chat.zip', isDirectory: false }],
    text: 'first',
};

describe('mergedShareRequest', () => {
    it('takes a request when none is pending', () => {
        expect(mergedShareRequest(undefined, first)).toBe(first);
    });

    it('adds a second share to the pending one instead of replacing it', () => {
        expect(
            mergedShareRequest(first, {
                requestId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
                files: [
                    { path: '/inbox/a/chat.zip', isDirectory: false },
                    { path: '/inbox/b/photo.png', isDirectory: false },
                ],
                text: 'second',
            }),
        ).toEqual({
            requestId: first.requestId,
            files: [
                { path: '/inbox/a/chat.zip', isDirectory: false },
                { path: '/inbox/b/photo.png', isDirectory: false },
            ],
            text: 'first\n\nsecond',
        });
    });
});
