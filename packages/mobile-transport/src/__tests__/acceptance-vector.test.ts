import { describe, expect, it } from 'vitest';

import {
    MOBILE_TRANSPORT_ACCEPTANCE_VECTOR_ID,
    verifyMobileTransportAcceptanceVector,
} from '../acceptance-vector';

describe('mobile transport Acceptance vector', () => {
    it('keeps the Node runtime fixed vector stable for Android comparison', () => {
        expect(MOBILE_TRANSPORT_ACCEPTANCE_VECTOR_ID).toBe('caxri-mobile-transport-v4');
        expect(verifyMobileTransportAcceptanceVector()).toEqual({
            algorithms: ['X25519', 'HKDF-SHA256', 'AES-256-GCM'],
            protocolVersion: 4,
            status: 'passed',
            vectorId: 'caxri-mobile-transport-v4',
        });
    });
});
