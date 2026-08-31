import { Buffer } from 'node:buffer';

import { MOBILE_GATEWAY_MAX_PLAINTEXT_BYTES } from '@caxri/mobile-transport';
import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { boundedMobileReply } from '../gateway';

describe('boundedMobileReply', () => {
    it('returns a typed capacity failure instead of disconnecting on an oversized result', () => {
        const raw = { id: 'request-1' };
        const bounded = boundedMobileReply(raw, {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            id: 'request-1',
            ok: true,
            result: 'x'.repeat(MOBILE_GATEWAY_MAX_PLAINTEXT_BYTES),
        });
        expect(bounded).toMatchObject({
            id: 'request-1',
            ok: false,
            error: { code: 'CAPACITY' },
        });
        expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThan(
            MOBILE_GATEWAY_MAX_PLAINTEXT_BYTES,
        );
    });
});
