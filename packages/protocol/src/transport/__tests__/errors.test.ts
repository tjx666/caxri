import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
    CaxriError,
    errorMessage,
    fromWireError,
    isCaxriError,
    toErrorCode,
    toWireError,
} from '../errors';

describe('CaxriError classification', () => {
    it('recognizes a real CaxriError instance and preserves its code and details', () => {
        const error = new CaxriError('NOT_FOUND', 'missing', { id: 'x' });
        expect(isCaxriError(error)).toBe(true);
        expect(toWireError(error)).toEqual({
            code: 'NOT_FOUND',
            message: 'missing',
            details: { id: 'x' },
        });
    });

    it('omits the details field entirely when the error carries none', () => {
        const error = new CaxriError('IO', 'disk failure');
        expect(toWireError(error)).toEqual({ code: 'IO', message: 'disk failure' });
    });

    it('recognizes an equivalent CaxriError emitted by a second bundled copy of the package', () => {
        class OtherCaxriError extends Error {
            constructor(
                readonly code: string,
                message: string,
                readonly details?: Record<string, unknown>,
            ) {
                super(message);
                this.name = 'CaxriError';
            }
        }
        const clone = new OtherCaxriError('CONFLICT', 'duplicate');
        expect(isCaxriError(clone)).toBe(true);
        expect(isCaxriError(clone)).toBe(true);
    });

    it('rejects a look-alike error with an unrecognized code or malformed details', () => {
        class FakeError extends Error {
            constructor(
                readonly code: string,
                message: string,
                readonly details?: unknown,
            ) {
                super(message);
                this.name = 'CaxriError';
            }
        }
        expect(isCaxriError(new FakeError('NOT_A_REAL_CODE', 'bad'))).toBe(false);
        expect(isCaxriError(new FakeError('IO', 'bad', ['array is not a details object']))).toBe(
            false,
        );
        expect(isCaxriError(new Error('plain error'))).toBe(false);
        expect(isCaxriError('not an error at all')).toBe(false);
        expect(isCaxriError(null)).toBe(false);
    });

    it('falls back to the caller-supplied message only for non-Error throws', () => {
        expect(errorMessage(new Error('boom'), 'fallback')).toBe('boom');
        expect(errorMessage('a rejected string', 'fallback')).toBe('fallback');
        expect(errorMessage(null, 'fallback')).toBe('fallback');
    });

    it('decays an unrecognized code to INTERNAL so newer Runtime codes stay forward compatible', () => {
        expect(toErrorCode('NOT_FOUND')).toBe('NOT_FOUND');
        expect(toErrorCode('SOME_FUTURE_CODE')).toBe('INTERNAL');
        expect(toErrorCode(undefined)).toBe('INTERNAL');
    });

    it('formats a Zod validation failure as one readable sentence without echoing rejected values', () => {
        const schema = z.object({ name: z.string().min(1) });
        const result = schema.safeParse({ name: '' });
        expect(result.success).toBe(false);
        const wire = toWireError(result.error);
        expect(wire.code).toBe('VALIDATION');
        expect(wire.message).toContain('name:');
        expect(wire.message).not.toContain('undefined');
    });

    it('truncates a large batch of Zod issues and reports the overflow count', () => {
        const schema = z.object({
            a: z.string(),
            b: z.string(),
            c: z.string(),
            d: z.string(),
            e: z.string(),
            f: z.string(),
            g: z.string(),
        });
        const result = schema.safeParse({});
        expect(result.success).toBe(false);
        const wire = toWireError(result.error);
        expect(wire.message).toContain('+2 more');
    });

    it('classifies an unrecognized thrown value as an unclassified INTERNAL fault', () => {
        expect(toWireError('a raw string throw')).toEqual({
            code: 'INTERNAL',
            message: 'Unknown Caxri error',
        });
        expect(toWireError(new Error('unexpected'))).toEqual({
            code: 'INTERNAL',
            message: 'unexpected',
        });
    });

    it('rebuilds a CaxriError after a structured-clone hop erased its prototype', () => {
        const rebuilt = fromWireError({
            code: 'CONFLICT',
            message: 'stale write',
            details: { rev: 1 },
        });
        expect(rebuilt).toBeInstanceOf(CaxriError);
        expect(rebuilt.code).toBe('CONFLICT');
        expect(rebuilt.message).toBe('stale write');
        expect(rebuilt.details).toEqual({ rev: 1 });
    });

    it('falls back to safe defaults when the wire payload is missing, malformed, or empty', () => {
        expect(fromWireError(null)).toMatchObject({
            code: 'INTERNAL',
            message: 'Unknown Caxri error',
        });
        expect(fromWireError('not an object')).toMatchObject({
            code: 'INTERNAL',
            message: 'Unknown Caxri error',
        });
        expect(fromWireError({ code: 'BOGUS_CODE', message: '' })).toMatchObject({
            code: 'INTERNAL',
            message: 'Unknown Caxri error',
        });
        expect(
            fromWireError({ code: 'IO', message: 'ok', details: 'not an object' }).details,
        ).toBeUndefined();
    });
});
