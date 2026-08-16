import { describe, expect, it } from 'vitest';

import { assertNever } from '../assert-never';
import { CaxriError } from '../errors';

/**
 * Exercises the runtime fallback for an unhandled discriminated-union member; the cast is required because
 * `assertNever` intentionally accepts only `never` at the type level.
 */
function unreachable(value: string): never {
    return value as never;
}

describe('assertNever', () => {
    it('throws a typed INTERNAL CaxriError describing the unreachable value', () => {
        expect(() => assertNever(unreachable('unexpected-variant'))).toThrow(CaxriError);
        let caught: unknown;
        try {
            assertNever(unreachable('unexpected-variant'));
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(CaxriError);
        expect((caught as CaxriError).code).toBe('INTERNAL');
        expect((caught as CaxriError).message).toContain('unexpected-variant');
    });

    it('uses a caller-supplied prefix message when provided', () => {
        let caught: unknown;
        try {
            assertNever(unreachable('bogus'), 'Unhandled event kind');
        } catch (error) {
            caught = error;
        }
        expect((caught as CaxriError).message).toBe('Unhandled event kind: bogus');
    });
});
