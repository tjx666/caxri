import { describe, expect, it } from 'vitest';

import {
    extensionErrorShape,
    extensionRequestFailureRecord,
    hostError,
    isHostOriginatedError,
    providerFailure,
} from '../extension-error';

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

describe('extensionRequestFailureRecord', () => {
    it.each([
        ['CANCELLED', 'cancelled'],
        ['GENERATION_EXPIRED', 'generation-superseded'],
    ])('reports a host-originated %s as a retryable non-fault at debug', (code, reason) => {
        const error = hostError(code, 'host-originated');
        expect(extensionRequestFailureRecord(code, error)).toEqual({
            failure: {
                code,
                owner: 'extension-host',
                phase: 'execute',
                reason,
                remediation: 'none',
                retryable: true,
            },
            level: 'debug',
        });
    });

    it.each(['CANCELLED', 'GENERATION_EXPIRED'])(
        'keeps an extension-forged %s at warn with the restart remediation',
        (code) => {
            // An extension provider can throw a matching code, but never through `hostError`.
            const forged = Object.assign(new Error('boom'), { code });
            expect(isHostOriginatedError(forged)).toBe(false);
            expect(extensionRequestFailureRecord(code, forged)).toEqual({
                failure: {
                    code,
                    owner: 'extension-host',
                    phase: 'execute',
                    reason: 'unknown',
                    remediation: 'restart-extension-host',
                    retryable: false,
                },
                level: 'warn',
            });
        },
    );

    it('keeps a real provider failure at warn with the restart remediation', () => {
        const error = Object.assign(new Error('activation failed'), { code: 'ACTIVATION_FAILED' });
        expect(extensionRequestFailureRecord('ACTIVATION_FAILED', error)).toEqual({
            failure: {
                code: 'ACTIVATION_FAILED',
                owner: 'extension-host',
                phase: 'execute',
                reason: 'unknown',
                remediation: 'restart-extension-host',
                retryable: false,
            },
            level: 'warn',
        });
    });
});

describe('providerFailure', () => {
    const current = { cancelled: false, generationExpired: false };

    it('re-mints a provider-thrown CANCELLED as host-originated once the host cancelled the request', () => {
        // The bundled Git extension's `assertNotCancelled` throws its own plain CANCELLED after the host cancelled (#587).
        const thrown = Object.assign(new Error('Source Control request was cancelled'), {
            code: 'CANCELLED',
        });
        const failure = providerFailure(thrown, { ...current, cancelled: true }, 'fallback');
        expect(failure).not.toBe(thrown);
        expect(failure).toMatchObject({ code: 'CANCELLED', message: thrown.message });
        expect(isHostOriginatedError(failure)).toBe(true);
        expect(extensionRequestFailureRecord('CANCELLED', failure).level).toBe('debug');
    });

    it('re-mints a provider-thrown GENERATION_EXPIRED only when host state turned over', () => {
        const thrown = Object.assign(new Error('superseded'), { code: 'GENERATION_EXPIRED' });
        expect(
            isHostOriginatedError(
                providerFailure(thrown, { ...current, generationExpired: true }, 'fallback'),
            ),
        ).toBe(true);
        expect(isHostOriginatedError(providerFailure(thrown, current, 'fallback'))).toBe(false);
    });

    it('keeps a provider-thrown non-fault code a fault when the host cannot corroborate it', () => {
        const thrown = Object.assign(new Error('boom'), { code: 'CANCELLED' });
        const failure = providerFailure(thrown, current, 'fallback');
        expect(failure).toMatchObject({ code: 'CANCELLED', message: 'boom' });
        expect(isHostOriginatedError(failure)).toBe(false);
        expect(extensionRequestFailureRecord('CANCELLED', failure)).toMatchObject({
            level: 'warn',
            failure: { remediation: 'restart-extension-host' },
        });
    });

    it('strips host origin from a host-minted error that an extension re-throws', () => {
        // An extension can capture a rejection from a `caxri.*` call and throw it from its own provider later.
        const captured = hostError('GENERATION_EXPIRED', 'Extension API binding has expired');
        const failure = providerFailure(captured, current, 'fallback');
        expect(failure).not.toBe(captured);
        expect(failure).toMatchObject({ code: 'GENERATION_EXPIRED' });
        expect(isHostOriginatedError(failure)).toBe(false);
        expect(extensionRequestFailureRecord('GENERATION_EXPIRED', failure).level).toBe('warn');
    });

    it('normalizes uncoded and non-Error failures', () => {
        expect(providerFailure(new Error('exploded'), current, 'fallback')).toMatchObject({
            code: 'PROVIDER_FAILED',
            message: 'exploded',
        });
        expect(providerFailure('nope', current, 'Tree provider failed')).toMatchObject({
            code: 'PROVIDER_FAILED',
            message: 'Tree provider failed',
        });
        expect(providerFailure({ code: 'CUSTOM' }, current, 'fallback')).toMatchObject({
            code: 'CUSTOM',
        });
    });
});
