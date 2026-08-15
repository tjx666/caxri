import { describe, expect, it } from 'vitest';

import { boundSnapshot, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_LINES } from '../snapshot';

describe('boundSnapshot', () => {
    it('retains only the newest 2,000 lines', () => {
        const result = boundSnapshot(
            Array.from({ length: 2_100 }, (_, index) => `line-${index}`).join('\n'),
        );
        expect(result.lineCount).toBe(MAX_SNAPSHOT_LINES);
        expect(result.payload).not.toContain('line-0\n');
        expect(result.payload).toContain('line-2099');
    });

    it('caps a single huge line by bytes', () => {
        const result = boundSnapshot('x'.repeat(MAX_SNAPSHOT_BYTES + 2_048));
        expect(result.byteCount).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
    });

    it('does not split a multibyte UTF-8 character at the byte boundary', () => {
        const result = boundSnapshot(`x${'界'.repeat(MAX_SNAPSHOT_BYTES)}`);

        expect(result.byteCount).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
        expect(result.payload).not.toContain('\u{FFFD}');
    });
});
