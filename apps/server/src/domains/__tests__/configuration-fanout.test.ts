// eslint-disable-next-line unicorn/name-replacements -- referenced by name in vitest.config.ts and scripts/__tests__/vitest-config-contract.test.ts; renaming is outside this change's scope.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigService } from '../config';

/**
 * Split from `configuration.test.ts` (rather than growing it past the repository's 600-line source-size ratchet)
 * because this caxri#1441 regression does not share state or helpers with that file's suite. It still constructs a real
 * `ConfigService` against a temp directory the same way that suite does, so it stays on the same `server-serial-native`
 * Vitest project (see `vitest.config.ts` and `scripts/__tests__/vitest-config-contract.test.ts`).
 */
const temporaryDirectories: string[] = [];
afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('ConfigurationService fan-out isolation', () => {
    it('notifies a later settings subscriber when an earlier one throws', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-settings-fanout-'));
        temporaryDirectories.push(directory);
        const write = vi.fn();
        const service = new ConfigService(directory, () => {}, {
            recordMetric: vi.fn(),
            write,
        } as unknown as StructuredLogger);
        await service.initialize();
        const failing = vi.fn(() => {
            throw new Error('settings listener failure');
        });
        const surviving = vi.fn();
        service.subscribeSettings(failing);
        service.subscribeSettings(surviving);

        await service.updateSettings(
            JSON.stringify({ ...service.getSettings().value, 'terminal.fontSize': 16 }),
        );

        expect(failing).toHaveBeenCalledTimes(1);
        expect(surviving).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith(
            'warn',
            logEventCatalog.configuration.settingsListenerFailed,
            { fields: { error: 'settings listener failure' } },
        );
        await service.close();
    });
});
