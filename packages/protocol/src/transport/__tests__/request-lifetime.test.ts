import { describe, expect, it } from 'vitest';

import { isNonExpiringRuntimeMethod } from '../request-lifetime';

describe('isNonExpiringRuntimeMethod', () => {
    it('allows the documented non-expiring methods', () => {
        expect(isNonExpiringRuntimeMethod('agent.dispatch.waitInternal')).toBe(true);
        expect(isNonExpiringRuntimeMethod('agent.message.wait')).toBe(true);
        expect(isNonExpiringRuntimeMethod('files.copy')).toBe(true);
        expect(isNonExpiringRuntimeMethod('files.write')).toBe(true);
    });

    it('rejects representative expiring and unrelated methods', () => {
        expect(isNonExpiringRuntimeMethod('agent.dispatch.wait')).toBe(false);
        expect(isNonExpiringRuntimeMethod('agent.dispatch.start')).toBe(false);
        expect(isNonExpiringRuntimeMethod('files.read')).toBe(false);
        expect(isNonExpiringRuntimeMethod('terminal.send')).toBe(false);
        expect(isNonExpiringRuntimeMethod('')).toBe(false);
    });
});
