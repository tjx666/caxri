import { describe, expect, it } from 'vitest';

import { CLI_PROTOCOL_VERSION } from '../index';

describe('@caxri/cli package boundary', () => {
    it('uses the workspace protocol contract', () => {
        expect(CLI_PROTOCOL_VERSION).toBe(2);
    });
});
