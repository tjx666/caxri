import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDomainServices } from './domain-services';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
    vi.restoreAllMocks();
});

describe('createTestDomainServices', () => {
    it('waits for the injected logger to drain when the test composition root closes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-logger-drain-'));
        temporaryDirectories.push(directory);
        const logger = new StructuredLogger(join(directory, 'logs'));
        const runtime = await createTestDomainServices({
            userDataPath: join(directory, 'user-data'),
            logger,
            send: () => {},
        });
        const gate = Promise.withResolvers<void>();
        const drain = logger.flush.bind(logger);
        const flush = vi.spyOn(logger, 'flush').mockImplementationOnce(async () => {
            await gate.promise;
            await drain();
        });
        const closed = vi.fn();
        const closing = (async () => {
            await runtime.close();
            closed();
        })();

        try {
            await vi.waitFor(() => expect(flush).toHaveBeenCalled());
            expect(closed).not.toHaveBeenCalled();
            gate.resolve();
            await closing;
            expect(closed).toHaveBeenCalledOnce();
        } finally {
            gate.resolve();
            await closing;
        }
    });
});
