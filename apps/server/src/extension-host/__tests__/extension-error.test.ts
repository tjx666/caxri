import { describe, expect, it } from 'vitest';

import {
    createProviderRequestScope,
    extensionErrorShape,
    extensionRequestFailureRecord,
    hostError,
    isHostOriginatedError,
    providerFailure,
    recordHostApiRejection,
    supersededError,
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
    const current = {
        cancelled: false,
        generationExpired: false,
        scope: createProviderRequestScope(),
    };

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

    it('re-mints a propagated GENERATION_EXPIRED once the host expired an API call the request issued', () => {
        // The bundled Git and Status providers await `caxri.*` calls without a catch, so Server Core's own
        // Session-switch rejection reaches the boundary as-is; the API layer records that decision on the scope.
        const scope = createProviderRequestScope();
        recordHostApiRejection(scope, 'GENERATION_EXPIRED');
        const propagated = Object.assign(
            new Error('Active Project changed while the extension request was running'),
            { code: 'GENERATION_EXPIRED' },
        );
        const failure = providerFailure(propagated, { ...current, scope }, 'fallback');
        expect(failure).toMatchObject({ code: 'GENERATION_EXPIRED', message: propagated.message });
        expect(isHostOriginatedError(failure)).toBe(true);
        expect(extensionRequestFailureRecord('GENERATION_EXPIRED', failure).level).toBe('debug');
    });

    it('records an extension-declared superseded revision as a non-fault without host corroboration', () => {
        // The bundled Git extension's model revision is its own state, so no host turnover can ever corroborate it
        // (#614). Identity is what makes this different from the forged code in the test below.
        const declared = supersededError('Source Control snapshot was superseded');
        const failure = providerFailure(declared, current, 'fallback');
        expect(failure).not.toBe(declared);
        expect(failure).toMatchObject({
            code: 'GENERATION_EXPIRED',
            message: declared.message,
        });
        expect(isHostOriginatedError(failure)).toBe(true);
        expect(extensionRequestFailureRecord('GENERATION_EXPIRED', failure)).toMatchObject({
            failure: { reason: 'generation-superseded', remediation: 'none' },
            level: 'debug',
        });
    });

    it('keeps a copy of a declared superseded error a fault, since only the original object is declared', () => {
        // An extension that reads the message and code off a declared error and rethrows its own object has not
        // declared anything; the copy carries no membership, so #606's rule still applies to it.
        const declared = supersededError('Source Control snapshot was superseded');
        const copied = Object.assign(new Error(declared.message), { code: 'GENERATION_EXPIRED' });
        const failure = providerFailure(copied, current, 'fallback');
        expect(isHostOriginatedError(failure)).toBe(false);
        expect(extensionRequestFailureRecord('GENERATION_EXPIRED', failure)).toMatchObject({
            failure: { remediation: 'restart-extension-host' },
            level: 'warn',
        });
    });

    it("re-mints a propagated CANCELLED once Server Core's own reply cancelled an API call", () => {
        // The controlled-view scope fence rejects a `workspace.request` whose Session is no longer active with
        // CANCELLED; the API layer records that as the host's decision, not the call token's.
        const scope = createProviderRequestScope();
        recordHostApiRejection(scope, 'CANCELLED');
        const propagated = Object.assign(new Error('Controlled view scope is no longer active'), {
            code: 'CANCELLED',
        });
        const failure = providerFailure(propagated, { ...current, scope }, 'fallback');
        expect(isHostOriginatedError(failure)).toBe(true);
        expect(extensionRequestFailureRecord('CANCELLED', failure).level).toBe('debug');
    });

    it('records only non-fault codes on a live request scope', () => {
        const scope = createProviderRequestScope();
        recordHostApiRejection(scope, 'GIT_FAILED');
        recordHostApiRejection(undefined, 'GENERATION_EXPIRED');
        expect(scope).toEqual({ hostCancelledApiCall: false, hostExpiredApiCall: false });
        const forged = Object.assign(new Error('boom'), { code: 'GENERATION_EXPIRED' });
        expect(
            isHostOriginatedError(providerFailure(forged, { ...current, scope }, 'fallback')),
        ).toBe(false);
    });

    it("keeps each boundary's wire code for an uncoded failure", () => {
        expect(
            providerFailure(new Error('boom'), current, 'fallback', 'ACTIVATION_FAILED'),
        ).toMatchObject({ code: 'ACTIVATION_FAILED', message: 'boom' });
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
        // A non-Error throw keeps its text; only a nullish or empty throw falls back to the boundary's message.
        expect(providerFailure('nope', current, 'Tree provider failed')).toMatchObject({
            code: 'PROVIDER_FAILED',
            message: 'nope',
        });
        expect(providerFailure(undefined, current, 'Tree provider failed')).toMatchObject({
            code: 'PROVIDER_FAILED',
            message: 'Tree provider failed',
        });
        expect(providerFailure({ code: 'CUSTOM' }, current, 'fallback')).toMatchObject({
            code: 'CUSTOM',
        });
    });
});
