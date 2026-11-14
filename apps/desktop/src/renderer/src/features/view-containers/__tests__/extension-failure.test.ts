import { CaxriError } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import {
    describeExtensionFailure,
    describeExtensionFailureReason,
    extensionRequestFailureReason,
} from '../extension-failure';

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
    it('explains a timed-out view read instead of echoing the raw request diagnostic', () => {
        const reason = extensionRequestFailureReason(
            new CaxriError('TIMEOUT', 'Caxri Server request timed out: view.treeChildren'),
        );
        expect(reason).toBe('timeout');
        expect(describeExtensionFailureReason(reason, translate)).toBe(
            'The extension did not respond in time. Try again.',
        );
    });
    it('classifies Server request codes and falls back for anything else', () => {
        expect(extensionRequestFailureReason(new CaxriError('CAPACITY', 'x'))).toBe('busy');
        expect(extensionRequestFailureReason(new CaxriError('FORBIDDEN', 'x'))).toBe('denied');
        expect(extensionRequestFailureReason(new CaxriError('UNAVAILABLE', 'x'))).toBe(
            'interrupted',
        );
        expect(extensionRequestFailureReason(new CaxriError('INTERNAL', 'x'))).toBe('generic');
        expect(extensionRequestFailureReason(new Error('boom'))).toBe('generic');
    });
});
