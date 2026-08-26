import { describe, expect, it } from 'vitest';

import { extensionErrorShape } from '../extension-error';

describe('extensionErrorShape', () => {
    it('classifies CommonJS access to the ESM-only caxri API', () => {
        for (const code of [
            'ERR_PACKAGE_PATH_NOT_EXPORTED',
            'ERR_REQUIRE_ESM',
            'ERR_MODULE_NOT_FOUND',
            'MODULE_NOT_FOUND',
        ]) {
            const error = Object.assign(new Error('Cannot require the caxri package'), { code });
            expect(extensionErrorShape(error)).toMatchObject({ code: 'COMMONJS_API_UNSUPPORTED' });
        }
    });

    it('preserves stable loader errors and classifies unknown activation failures', () => {
        const loaderError = Object.assign(new Error('Electron is unavailable'), {
            code: 'ELECTRON_IMPORT_DENIED',
        });
        expect(extensionErrorShape(loaderError)).toEqual({
            code: 'ELECTRON_IMPORT_DENIED',
            message: 'Electron is unavailable',
        });
        expect(extensionErrorShape(new Error('activation failed'))).toEqual({
            code: 'ACTIVATION_FAILED',
            message: 'activation failed',
        });
    });

    it('bounds provider errors before they cross the shared Host IPC boundary', () => {
        const error = Object.assign(new Error('x'.repeat(3_000)), { code: 'Y'.repeat(200) });
        const shaped = extensionErrorShape(error);

        expect(shaped.code).toHaveLength(100);
        expect(shaped.message).toHaveLength(2_048);
    });
});
