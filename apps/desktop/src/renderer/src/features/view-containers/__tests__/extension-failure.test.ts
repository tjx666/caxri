import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import { describeExtensionFailure } from '../extension-failure';

describe('extension failure recovery', () => {
    it('explains a reconnect without exposing raw diagnostics', () => {
        expect(
            describeExtensionFailure(
                {
                    code: 'EXTENSION_HOST_UNAVAILABLE',
                    message: 'raw diagnostic',
                },
                translate,
            ),
        ).toBe('The extension connection was interrupted. Retry to reconnect.');
    });
    it('distinguishes denied access from a retryable timeout', () => {
        expect(
            describeExtensionFailure({ code: 'CAPABILITY_DENIED', message: 'raw' }, translate),
        ).toContain('does not have access');
        expect(
            describeExtensionFailure({ code: 'PROVIDER_TIMEOUT', message: 'raw' }, translate),
        ).toContain('did not respond in time');
    });
});
