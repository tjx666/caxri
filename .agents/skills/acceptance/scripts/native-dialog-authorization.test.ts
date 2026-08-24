import { describe, expect, it } from 'vitest';

import {
    assertNativeDialogAuthorization,
    NATIVE_DIALOG_AUTHORIZATION_ENV,
    NATIVE_DIALOG_AUTHORIZATION_VALUE,
} from './native-dialog-authorization';

describe('Acceptance native dialog authorization', () => {
    it('fails closed without a current-request authorization marker', () => {
        expect(() => assertNativeDialogAuthorization({})).toThrow(
            'Native dialog automation requires an explicit user request',
        );
        expect(() =>
            assertNativeDialogAuthorization({
                [NATIVE_DIALOG_AUTHORIZATION_ENV]: '1',
            }),
        ).toThrow('Native dialog automation requires an explicit user request');
    });

    it('accepts only the exact explicit-user-request marker', () => {
        expect(() =>
            assertNativeDialogAuthorization({
                [NATIVE_DIALOG_AUTHORIZATION_ENV]: NATIVE_DIALOG_AUTHORIZATION_VALUE,
            }),
        ).not.toThrow();
    });
});
