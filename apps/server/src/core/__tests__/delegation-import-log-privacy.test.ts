import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { expect, it, onTestFinished } from 'vitest';

import { ConfigService } from '../../domains/config';
import type { DomainHandlers } from '../../domains/domain-services';
import { createOperationDispatcher } from '../operation-dispatcher';

/**
 * The dispatcher writes every failed request's message to the Server log, so a rejected import must not put text from
 * the file into it.
 */
it('logs a rejected delegation import without any text from the file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-import-log-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const config = new ConfigService(join(directory, 'user-data'), () => {});
    await config.initialize();
    onTestFinished(() => config.close());
    const logger = new StructuredLogger(join(directory, 'logs'));
    const dispatch = createOperationDispatcher(
        {
            'settings.delegation.import': (
                parameters: Parameters<ConfigService['importDelegationSettings']>[0],
            ) => config.importDelegationSettings(parameters),
        } as unknown as DomainHandlers,
        logger,
    );
    const source = JSON.stringify({
        maxDepth: 2,
        agents: [
            {
                'name': 'review',
                'harness': 'claude',
                'useWhen': 'Review',
                'private-sentinel': 'Synthetic private instructions',
            },
        ],
        callers: { 'private-sentinel': { prepend: 'Synthetic private instructions' } },
    });
    await expect(
        dispatch({
            id: 'import-1',
            method: 'settings.delegation.import',
            params: { sourceText: source },
        }),
    ).rejects.toMatchObject({
        code: 'VALIDATION',
        details: { issues: expect.any(Array) as unknown[] },
    });
    await logger.flush();
    const log = await readFile(logger.path, 'utf8');
    expect(log).toContain('Delegation presets could not be imported');
    expect(log).not.toMatch(/sentinel|Synthetic/u);
});
