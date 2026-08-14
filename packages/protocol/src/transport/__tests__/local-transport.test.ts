import { describe, expect, it } from 'vitest';

import { MAX_CONFIGURABLE_FILE_BYTES } from '../../domain/domain';
import { LOCAL_TRANSPORT_MAX_FRAME_BYTES, LocalJsonLineDecoder } from '../local-transport';

describe('LocalJsonLineDecoder', () => {
    it('decodes a multi-megabyte frame incrementally without retaining consumed prefixes', () => {
        const decoder = new LocalJsonLineDecoder();
        const body = 'x'.repeat(2 * 1024 * 1024);
        const frame = JSON.stringify({ body });
        const midpoint = Math.floor(frame.length / 2);

        expect(decoder.push(frame.slice(0, midpoint))).toEqual([]);
        expect(decoder.push(`${frame.slice(midpoint)}\n`)).toEqual([frame]);
    });

    it('rejects an unterminated frame above the shared transport bound', () => {
        const maximumEscapedDiffBytes = 2 * MAX_CONFIGURABLE_FILE_BYTES * 6;
        expect(LOCAL_TRANSPORT_MAX_FRAME_BYTES).toBeGreaterThan(maximumEscapedDiffBytes);
        const decoder = new LocalJsonLineDecoder(16);

        expect(() => decoder.push('x'.repeat(17))).toThrow(RangeError);
    });
});
