import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { StructuredLogger } from '../logger';

describe('StructuredLogger', () => {
    it('skips verbose records below the configured production threshold', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-logger-'));
        try {
            const logger = new StructuredLogger(directory, 'runtime', 'info');
            logger.write('debug', 'ignored');
            logger.write('info', 'kept');

            expect(await readFile(logger.path, 'utf8')).not.toContain('ignored');
            expect(await readFile(logger.path, 'utf8')).toContain('kept');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
