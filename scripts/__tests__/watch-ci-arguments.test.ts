import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseArguments } from '../watch-ci';

const SCRIPT = join(import.meta.dirname, '..', 'watch-ci.ts');
const VALUE_FLAGS = ['--run', '--branch', '--pr', '--workflow'];

/**
 * Each case is a value flag with no usable operand: nothing after it, an empty string, or another flag.
 */
const INVALID_CASES = VALUE_FLAGS.flatMap((flag) => [
    { argv: [flag], label: `${flag} with no operand` },
    { argv: [flag, ''], label: `${flag} with an empty operand` },
    { argv: [flag, '--quiet'], label: `${flag} followed by another flag` },
]);

describe('watch-ci argument parsing', () => {
    let shimDirectory: string;
    let callLog: string;

    beforeEach(() => {
        shimDirectory = mkdtempSync(join(tmpdir(), 'watch-ci-shim-'));
        callLog = join(shimDirectory, 'calls.log');
        // Fake external tools that record every invocation, so a call made before validation is observable.
        for (const tool of ['git', 'gh', 'osascript', 'terminal-notifier']) {
            const path = join(shimDirectory, tool);
            writeFileSync(path, `#!/bin/sh\necho "${tool} $*" >> "${callLog}"\nexit 1\n`);
            chmodSync(path, 0o755);
        }
    });

    afterEach(() => {
        rmSync(shimDirectory, { force: true, recursive: true });
    });

    it('covers twelve invalid combinations', () => {
        expect(INVALID_CASES).toHaveLength(12);
    });

    it.each(INVALID_CASES)('rejects $label before any external call', ({ argv }) => {
        expect(() => parseArguments(argv)).toThrow(/requires a value/);

        const result = spawnSync('bun', ['run', SCRIPT, ...argv], {
            encoding: 'utf8',
            env: { ...process.env, PATH: `${shimDirectory}:${process.env.PATH ?? ''}` },
            timeout: 30_000,
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('requires a value');
        expect(existsSync(callLog)).toBe(false);
    });

    it('still accepts well-formed operands', () => {
        expect(parseArguments(['--pr', '12', '--workflow', 'Guards', '--quiet'])).toEqual({
            pr: '12',
            quiet: true,
            workflow: 'Guards',
        });
        expect(parseArguments(['--run', '99'])).toEqual({ quiet: false, run: '99' });
        expect(parseArguments(['--branch', 'feat/x'])).toEqual({ branch: 'feat/x', quiet: false });
    });
});
