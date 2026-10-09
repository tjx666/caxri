import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { redactArtifactText, redactTree } from '../redact-e2e-artifacts.ts';

const execFileAsync = promisify(execFile);
const home = '/Users/runner-account';
const encoder = new TextEncoder();

describe('E2E failure artifact redaction', () => {
    let root: string | undefined;

    afterEach(async () => {
        if (root) await rm(root, { recursive: true, force: true });
        root = undefined;
    });

    it('replaces home prefixes in text and leaves binary content alone', () => {
        expect(
            redactArtifactText(
                encoder.encode(`at ${home}/actions-runner/_work/caxri/e2e/spec.e2e.ts:12`),
                [home],
            ),
        ).toBe('at $HOME/actions-runner/_work/caxri/e2e/spec.e2e.ts:12');
        expect(redactArtifactText(encoder.encode('no paths here'), [home])).toBeUndefined();
        const binary = new Uint8Array([0x89, 0x50, 0x00, ...encoder.encode(home)]);
        expect(redactArtifactText(binary, [home])).toBeUndefined();
    });

    it('rewrites text files and the text entries of trace archives in place', async () => {
        root = await mkdtemp(join(tmpdir(), 'caxri-redact-artifacts-'));
        const testOutput = join(root, 'parallel-safe', 'spec-case');
        const traceSource = join(root, 'trace-source');
        await mkdir(testOutput, { recursive: true });
        await mkdir(traceSource);
        await writeFile(join(testOutput, 'error-context.md'), `Error at ${home}/work/spec.ts\n`);
        await writeFile(join(traceSource, 'test.trace'), `{"file":"${home}/work/spec.ts"}\n`);
        await writeFile(join(traceSource, 'screenshot.png'), new Uint8Array([0x89, 0x00, 0x01]));
        await execFileAsync('/usr/bin/zip', ['-qq', '-r', join(testOutput, 'trace.zip'), '.'], {
            cwd: traceSource,
        });

        expect(await redactTree(join(root, 'parallel-safe'), [home])).toBe(2);

        expect(await readFile(join(testOutput, 'error-context.md'), 'utf8')).toBe(
            'Error at $HOME/work/spec.ts\n',
        );
        const { stdout } = await execFileAsync('/usr/bin/unzip', [
            '-p',
            join(testOutput, 'trace.zip'),
            'test.trace',
        ]);
        expect(stdout).toBe('{"file":"$HOME/work/spec.ts"}\n');
        const listing = await execFileAsync('/usr/bin/unzip', [
            '-Z1',
            join(testOutput, 'trace.zip'),
        ]);
        expect(
            listing.stdout
                .split('\n')
                .filter(Boolean)
                .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(['screenshot.png', 'test.trace']);
    });
});
