import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ConfigurationService } from '../../configuration';

describe('CLI settings patch application handler', () => {
    it('validates dry runs through the real schema without writing or emitting', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-settings-dry-run-'));
        const emit = vi.fn();
        const service = new ConfigurationService(directory, emit);
        await service.initialize();
        const before = await readFile(service.settingsPath, 'utf8');
        emit.mockClear();

        const result = await service.patchSettings([{ key: 'terminal.fontSize', value: 17 }], true);

        expect(result).toMatchObject({ dryRun: true, changedKeys: ['terminal.fontSize'] });
        expect(result.value['terminal.fontSize']).toBe(17);
        expect(await readFile(service.settingsPath, 'utf8')).toBe(before);
        expect(emit).not.toHaveBeenCalled();
        await service.close();
    });

    it('atomically applies valid changes and preserves prior state after invalid input', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-settings-patch-'));
        const emit = vi.fn();
        const service = new ConfigurationService(directory, emit);
        await service.initialize();
        emit.mockClear();

        const result = await service.patchSettings(
            [{ key: 'terminal.fontSize', value: 18 }],
            false,
        );
        expect(result).toMatchObject({ dryRun: false, changedKeys: ['terminal.fontSize'] });
        expect(service.getSettings().value['terminal.fontSize']).toBe(18);
        expect(emit).toHaveBeenCalledTimes(1);

        await expect(
            service.patchSettings([{ key: 'terminal.fontSize', value: 99 }], false),
        ).rejects.toThrow('terminal.fontSize');
        expect(service.getSettings().value['terminal.fontSize']).toBe(18);
        expect(emit).toHaveBeenCalledTimes(1);
        await service.close();
    });
});
