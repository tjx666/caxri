import { describe, expect, it } from 'vitest';

import { CAXRI_PROTOCOL_VERSION } from './index';

describe('@caxri/protocol package boundary', () => {
    it('publishes one stable protocol version', () => {
        expect(CAXRI_PROTOCOL_VERSION).toBe(1);
    });
});
