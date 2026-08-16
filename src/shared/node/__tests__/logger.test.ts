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

    it('recreates a deleted log directory instead of throwing into the caller', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-logger-'));
        try {
            const logger = new StructuredLogger(directory);
            logger.write('info', 'before-removal');

            // Profile teardown (or uninstall tooling) can delete the log directory while a late
            // async callback still logs; that write must be best-effort, never an exception.
            await rm(directory, { recursive: true, force: true });
            expect(() => logger.write('warn', 'after-removal')).not.toThrow();

            expect(await readFile(logger.path, 'utf8')).toContain('after-removal');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
