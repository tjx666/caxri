import { describe, expect, it } from 'vitest';

import { describeExtensionFailure } from '../extension-failure';

describe('extension failure recovery', () => {
    it('explains a reconnect without exposing raw diagnostics', () => {
        expect(
            describeExtensionFailure({
                code: 'EXTENSION_HOST_UNAVAILABLE',
                message: 'raw diagnostic',
            }),
        ).toBe('The extension connection was interrupted. Retry to reconnect.');
    });
    it('distinguishes denied access from a retryable timeout', () => {
        expect(describeExtensionFailure({ code: 'CAPABILITY_DENIED', message: 'raw' })).toContain(
            'does not have access',
        );
        expect(describeExtensionFailure({ code: 'PROVIDER_TIMEOUT', message: 'raw' })).toContain(
            'did not respond in time',
        );
    });
});
