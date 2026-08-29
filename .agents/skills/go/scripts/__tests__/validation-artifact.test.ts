import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createValidationLog } from '../validation-artifact';

const cleanupPaths: string[] = [];

afterEach(async () => {
    const paths = [...cleanupPaths];
    cleanupPaths.length = 0;
    await Promise.all(paths.map((path) => rm(path, { force: true, recursive: true })));
});

describe('validation log writer', () => {
    it('bounds child output while preserving control lines and an integrity receipt', async () => {
        const runDirectory = await mkdtemp(join(tmpdir(), 'caxri-validation-log-'));
        cleanupPaths.push(runDirectory);
        await mkdir(join(runDirectory, 'validation'));
        const writer = await createValidationLog(runDirectory, 'validation/bounded.log', {
            highWatermarkBytes: 2,
            maxOutputBytes: 5,
        });

        expect(writer.writeOutput(Buffer.from('abc'))).toBe(true);
        expect(writer.needsBackpressure).toBe(true);
        expect(writer.writeOutput(Buffer.from('def'))).toBe(false);
        expect(writer.outputLimitExceeded).toBe(true);
        expect(writer.droppedOutputBytes).toBe(3);
        writer.write('CONTROL\n');
        const receipt = await writer.finish();
        const content = await readFile(join(runDirectory, 'validation/bounded.log'), 'utf8');

        expect(content).toBe('abcCONTROL\n');
        expect(receipt.byteLength).toBe(Buffer.byteLength(content));
        expect(receipt.sha256).toMatch(/^[0-9a-f]{64}$/u);
    });
});
