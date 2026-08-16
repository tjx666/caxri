import { CaxriError } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { parseCliArguments } from '../arguments';

describe('parseCliArguments timeout bounds', () => {
    it('accepts the lower and upper inclusive timeout bounds', () => {
        expect(parseCliArguments(['--timeout', '100']).timeoutMs).toBe(100);
        expect(parseCliArguments(['--timeout', '120000']).timeoutMs).toBe(120_000);
    });

    it('rejects a timeout just below the lower bound', () => {
        expect(() => parseCliArguments(['--timeout', '99'])).toThrow(CaxriError);
        expect(() => parseCliArguments(['--timeout', '99'])).toThrow(
            '--timeout must be 100-120000 milliseconds',
        );
    });

    it('rejects a timeout just above the upper bound', () => {
        expect(() => parseCliArguments(['--timeout', '120001'])).toThrow(
            '--timeout must be 100-120000 milliseconds',
        );
    });

    it('rejects a non-integer or unsafe timeout value', () => {
        expect(() => parseCliArguments(['--timeout', '100.5'])).toThrow(CaxriError);
        expect(() => parseCliArguments(['--timeout', 'not-a-number'])).toThrow(CaxriError);
    });

    it('applies the same bounds to --connect-timeout', () => {
        expect(parseCliArguments(['--connect-timeout', '100']).connectTimeoutMs).toBe(100);
        expect(() => parseCliArguments(['--connect-timeout', '120001'])).toThrow(
            '--connect-timeout must be 100-120000 milliseconds',
        );
    });
});

describe('parseCliArguments duplicate flag rejection', () => {
    it('rejects a repeated --profile', () => {
        expect(() => parseCliArguments(['--profile', 'a', '--profile', 'b'])).toThrow(
            '--profile may be provided only once',
        );
    });

    it('rejects a repeated --request-id', () => {
        expect(() => parseCliArguments(['--request-id', 'a', '--request-id', 'b'])).toThrow(
            '--request-id may be provided only once',
        );
    });

    it('rejects a --request-id exceeding 200 characters', () => {
        expect(() => parseCliArguments(['--request-id', 'a'.repeat(201)])).toThrow(
            '--request-id exceeds 200 characters',
        );
        expect(parseCliArguments(['--request-id', 'a'.repeat(200)]).requestId).toBe(
            'a'.repeat(200),
        );
    });
});

describe('parseCliArguments --json/--quiet conflict', () => {
    it('rejects combining --json and --quiet', () => {
        expect(() => parseCliArguments(['--json', '--quiet'])).toThrow(
            '--json and --quiet cannot be combined',
        );
    });

    it('accepts --json or --quiet alone', () => {
        expect(parseCliArguments(['--json']).json).toBe(true);
        expect(parseCliArguments(['--quiet']).quiet).toBe(true);
    });
});

describe('parseCliArguments argument count and length limits', () => {
    it('accepts exactly the maximum argument count', () => {
        const argv = Array.from({ length: 128 }, (_, index) => `token-${index}`);
        expect(parseCliArguments(argv).tokens).toHaveLength(128);
    });

    it('rejects one argument over the maximum count', () => {
        const argv = Array.from({ length: 129 }, (_, index) => `token-${index}`);
        expect(() => parseCliArguments(argv)).toThrow('CLI arguments exceed the supported limit');
    });

    it('accepts an argument at exactly the maximum length', () => {
        const argv = ['a'.repeat(4_096)];
        expect(parseCliArguments(argv).tokens).toEqual([argv[0]]);
    });

    it('rejects an argument one character over the maximum length', () => {
        expect(() => parseCliArguments(['a'.repeat(4_097)])).toThrow(
            'CLI arguments exceed the supported limit',
        );
    });
});

describe('parseCliArguments --timeout vs --connect-timeout precedence', () => {
    it('mirrors --timeout into connectTimeoutMs when --connect-timeout is not explicit', () => {
        const parsed = parseCliArguments(['--timeout', '5000']);
        expect(parsed.timeoutMs).toBe(5_000);
        expect(parsed.connectTimeoutMs).toBe(5_000);
    });

    it('keeps an explicit --connect-timeout independent when set before --timeout', () => {
        const parsed = parseCliArguments(['--connect-timeout', '2000', '--timeout', '5000']);
        expect(parsed.timeoutMs).toBe(5_000);
        expect(parsed.connectTimeoutMs).toBe(2_000);
    });

    it('keeps an explicit --connect-timeout independent when set after --timeout', () => {
        const parsed = parseCliArguments(['--timeout', '5000', '--connect-timeout', '2000']);
        expect(parsed.timeoutMs).toBe(5_000);
        expect(parsed.connectTimeoutMs).toBe(2_000);
    });
});

describe('parseCliArguments happy paths', () => {
    it('parses defaults when no arguments are given', () => {
        const parsed = parseCliArguments([]);
        expect(parsed).toEqual({
            connectTimeoutMs: 15_000,
            help: false,
            json: false,
            quiet: false,
            timeoutMs: 15_000,
            tokens: [],
            version: false,
            yes: false,
        });
    });

    it('parses flags, options, and positional tokens together', () => {
        const parsed = parseCliArguments([
            'status',
            '--json',
            '--yes',
            '--profile',
            '/profiles/one',
            '--request-id',
            'request-1',
            '--timeout',
            '2000',
        ]);
        expect(parsed).toEqual({
            connectTimeoutMs: 2_000,
            help: false,
            json: true,
            profile: '/profiles/one',
            quiet: false,
            requestId: 'request-1',
            timeoutMs: 2_000,
            tokens: ['status'],
            version: false,
            yes: true,
        });
    });

    it('recognizes --help/-h and --version/-V', () => {
        expect(parseCliArguments(['--help']).help).toBe(true);
        expect(parseCliArguments(['-h']).help).toBe(true);
        expect(parseCliArguments(['--version']).version).toBe(true);
        expect(parseCliArguments(['-V']).version).toBe(true);
    });

    it('requires a value for options expecting one', () => {
        expect(() => parseCliArguments(['--profile'])).toThrow('--profile requires a value');
        expect(() => parseCliArguments(['--profile', '--json'])).toThrow(
            '--profile requires a value',
        );
    });
});
