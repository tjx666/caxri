import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { shellQuote } from '../shell-quote';

const execFileAsync = promisify(execFile);

describe('shellQuote', () => {
    it.each([
        ['plain', 'abc'],
        ['empty', ''],
        ['single quotes', `it's 'quoted'`],
        ['metacharacters', '$(touch /tmp/x); `id` | & > < * ? ~ \\ "'],
        ['newlines', 'line one\nline two'],
        ['unicode', 'café \u{1F600}'],
    ])('round-trips %s through /bin/sh unchanged', async (_label, value) => {
        const { stdout } = await execFileAsync('/bin/sh', [
            '-c',
            `printf '%s' ${shellQuote(value)}`,
        ]);
        expect(stdout).toBe(value);
    });

    it('refuses NUL', () => {
        expect(() => shellQuote('a\0b')).toThrow(/NUL/u);
    });
});
