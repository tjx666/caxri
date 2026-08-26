import { describe, expect, it } from 'vitest';

import { isTranscriptAtLatest } from '../transcript-follow';

describe('transcript follow state', () => {
    it('treats the bottom threshold as following but preserves deliberate upward distance', () => {
        expect(
            isTranscriptAtLatest({ scrollHeight: 1000, scrollTop: 676, viewportHeight: 300 }),
        ).toBe(true);
        expect(
            isTranscriptAtLatest({ scrollHeight: 1000, scrollTop: 675, viewportHeight: 300 }),
        ).toBe(false);
        expect(
            isTranscriptAtLatest({ scrollHeight: 1000, scrollTop: 100, viewportHeight: 300 }),
        ).toBe(false);
    });
});
