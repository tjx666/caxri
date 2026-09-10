import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    agentDelegationSettingsSchema,
    hasRequiredCapabilities,
    methods,
    settingsPatchChangeSchema,
} from '@caxri/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';

import { ConfigService } from '../../config';

it('previews without writes and applies only delegation settings while preserving JSONC', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-settings-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const emit = vi.fn();
    const service = new ConfigService(directory, emit);
    await service.initialize();
    try {
        await service.updateSettings('// Keep this owner comment\n{"terminal.fontSize": 17}\n');
        const before = await readFile(service.settingsPath, 'utf8');
        const settings = agentDelegationSettingsSchema.parse({
            presets: [
                {
                    name: 'review',
                    provider: 'claude',
                    useWhen: 'Review',
                    instructions: 'Synthetic private instructions',
                },
            ],
        });
        emit.mockClear();
        expect(await service.importDelegationSettings(settings, true)).toEqual({
            dryRun: true,
            changed: true,
            presetNames: ['review'],
            maxDepth: 2,
        });
        expect(await readFile(service.settingsPath, 'utf8')).toBe(before);
        expect(emit).not.toHaveBeenCalled();
        const result = await service.importDelegationSettings(settings, false);
        expect(JSON.stringify(result)).not.toContain('Synthetic private instructions');
        expect(await readFile(service.settingsPath, 'utf8')).toContain(
            '// Keep this owner comment',
        );
        expect(service.getSettings().value['terminal.fontSize']).toBe(17);
        expect(service.getSettings().value['agents.delegation']).toEqual(settings);
        expect(await service.importDelegationSettings(settings, false)).toMatchObject({
            changed: false,
        });
        expect(
            settingsPatchChangeSchema.safeParse({ key: 'agents.delegation', value: settings })
                .success,
        ).toBe(false);
    } finally {
        await service.close();
    }
});

it('does not let a managed Agent use its ordinary settings grant to import private instructions', () => {
    const method = methods['settings.delegation.import'];
    expect(
        hasRequiredCapabilities(
            {
                principal: {
                    kind: 'agent',
                    id: 'agent',
                    endpointId: 'endpoint',
                    generation: 1,
                    projectIds: [],
                },
                capabilities: ['settings.write', 'agents.delegate'],
            },
            method.requiredCapabilities,
        ),
    ).toBe(false);
});
