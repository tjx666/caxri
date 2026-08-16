import { describe, expect, it } from 'vitest';

import { CaxriError } from '../errors';
import { negotiateProtocolVersion, protocolHelloSchema } from '../version';

describe('negotiateProtocolVersion', () => {
    it('raises a typed CONFLICT when no client version overlaps the supported set', () => {
        expect(() => negotiateProtocolVersion([1, 99])).toThrow(CaxriError);
        let caught: unknown;
        try {
            negotiateProtocolVersion([]);
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(CaxriError);
        expect((caught as CaxriError).code).toBe('CONFLICT');
    });
});

describe('protocolHelloSchema', () => {
    it('requires at least one supported version and rejects an empty list', () => {
        expect(protocolHelloSchema.safeParse({ supportedVersions: [] }).success).toBe(false);
        expect(protocolHelloSchema.safeParse({ supportedVersions: [2] }).success).toBe(true);
    });

    it('bounds the supported-version list so an untrusted peer cannot send an unbounded array', () => {
        const tooMany = Array.from({ length: 17 }, (_, index) => index + 1);
        expect(protocolHelloSchema.safeParse({ supportedVersions: tooMany }).success).toBe(false);
        expect(
            protocolHelloSchema.safeParse({ supportedVersions: tooMany.slice(0, 16) }).success,
        ).toBe(true);
    });
});
