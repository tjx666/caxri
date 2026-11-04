import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DelegationImportParameters } from '@caxri/protocol';
import {
    agentDelegationSettingsSchema,
    delegationImportParametersSchema,
    hasRequiredCapabilities,
    isCaxriError,
    MAX_CONFIGURATION_SOURCE_BYTES,
    methods,
    settingsPatchChangeSchema,
} from '@caxri/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';

import { ConfigService } from '../../config';

const SECRET = 'Synthetic private instructions';

function file(agents: unknown[], extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ maxDepth: 4, agents, ...extra });
}

function request(
    sourceText: string,
    overrides: Partial<DelegationImportParameters> = {},
): DelegationImportParameters {
    return delegationImportParametersSchema.parse({ sourceText, ...overrides });
}

async function open() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-settings-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const emit = vi.fn();
    const service = new ConfigService(directory, emit);
    await service.initialize();
    onTestFinished(() => service.close());
    return { service, emit };
}

async function expectRejection(promise: Promise<unknown>) {
    let error: unknown;
    try {
        await promise;
    } catch (error_) {
        error = error_;
    }
    expect(isCaxriError(error)).toBe(true);
    return error as { code: string; message: string; details: { issues: unknown[] } };
}

it('previews without writes and applies only delegation settings while preserving JSONC', async () => {
    const { service, emit } = await open();
    await service.updateSettings('// Keep this owner comment\n{"terminal.fontSize": 17}\n');
    const before = await readFile(service.settingsPath, 'utf8');
    const source = file([
        { name: 'review', harness: 'claude', useWhen: 'Review', instructions: SECRET },
    ]);
    emit.mockClear();
    const preview = await service.importDelegationSettings(request(source));
    expect(preview).toMatchObject({
        dryRun: true,
        mode: 'merge',
        changed: true,
        presetNames: ['review'],
        maxDepth: 2,
        diff: { presets: { added: ['review'] }, settings: [] },
    });
    expect(JSON.stringify(preview)).not.toContain(SECRET);
    expect(await readFile(service.settingsPath, 'utf8')).toBe(before);
    expect(emit).not.toHaveBeenCalled();
    await service.importDelegationSettings(request(source, { dryRun: false }));
    expect(await readFile(service.settingsPath, 'utf8')).toContain('// Keep this owner comment');
    expect(service.getSettings().value['terminal.fontSize']).toBe(17);
    expect(service.getSettings().value['agents.delegation'].presets[0]).toMatchObject({
        name: 'review',
        instructions: SECRET,
    });
    expect(await service.importDelegationSettings(request(source))).toMatchObject({
        changed: false,
    });
    expect(
        settingsPatchChangeSchema.safeParse({
            key: 'agents.delegation',
            value: agentDelegationSettingsSchema.parse({}),
        }).success,
    ).toBe(false);
});

it('merges by name, keeps current-only presets, maxDepth and switches; replace adopts the file', async () => {
    const { service } = await open();
    await service.importDelegationSettings(
        request(
            file([
                { name: 'keep-me', harness: 'claude', useWhen: 'Keep', effort: 'low' },
                { name: 'only-here', harness: 'codex', useWhen: 'Current only' },
            ]),
            { dryRun: false },
        ),
    );
    const written = JSON.parse(await readFile(service.settingsPath, 'utf8')) as Record<
        string,
        unknown
    >;
    written['agents.delegation'] = {
        ...(written['agents.delegation'] as object),
        readChildChat: false,
    };
    await service.updateSettings(JSON.stringify(written));
    const incoming = file([
        { name: 'keep-me', harness: 'claude', useWhen: 'Keep', effort: 'high' },
        { name: 'review', harness: 'grok', useWhen: 'Review' },
    ]);
    const merge = await service.importDelegationSettings(request(incoming));
    expect(merge.presetNames).toEqual(['keep-me', 'only-here', 'review']);
    expect(merge.diff.presets).toMatchObject({
        added: ['review'],
        changed: [{ name: 'keep-me', fields: ['effort'] }],
        removed: [],
    });
    expect(merge.maxDepth).toBe(2);
    expect(merge.diff.settings).toEqual([]);
    const replace = await service.importDelegationSettings(request(incoming, { mode: 'replace' }));
    expect(replace.presetNames).toEqual(['keep-me', 'review']);
    expect(replace.diff.presets.removed).toEqual(['only-here']);
    expect(replace.maxDepth).toBe(4);
    expect(replace.diff.settings).toEqual(['maxDepth']);
    await service.importDelegationSettings(request(incoming, { mode: 'replace', dryRun: false }));
    expect(service.getSettings().value['agents.delegation']).toMatchObject({
        readChildChat: false,
        maxDepth: 4,
    });
});

it('reports a changed caller rule in the preview', async () => {
    const { service } = await open();
    const preset = { name: 'review', harness: 'claude', useWhen: 'Review' };
    await service.importDelegationSettings(
        request(file([preset], { callers: { claude: { prepend: 'one' } } }), { dryRun: false }),
    );
    const preview = await service.importDelegationSettings(
        request(file([preset], { callers: { claude: { prepend: 'two' } } })),
    );
    expect(preview.diff.callers.changed).toEqual([{ provider: 'claude', fields: ['prepend'] }]);
});

it('refuses an apply whose preview revision is stale and writes nothing', async () => {
    const { service } = await open();
    const source = file([{ name: 'review', harness: 'claude', useWhen: 'Review' }]);
    const { revision } = await service.importDelegationSettings(request(source));
    await service.updateSettings('{"terminal.fontSize": 18}');
    const before = await readFile(service.settingsPath, 'utf8');
    const error = await expectRejection(
        service.importDelegationSettings(
            request(source, { dryRun: false, expectedRevision: revision }),
        ),
    );
    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect(await readFile(service.settingsPath, 'utf8')).toBe(before);
});

it('rejects invalid JSONC with a position and a fixed message', async () => {
    const { service } = await open();
    const error = await expectRejection(
        service.importDelegationSettings(request(`{\n  "maxDepth": ${SECRET}\n}`)),
    );
    expect(error.code).toBe('VALIDATION');
    expect(error.details.issues).toEqual([
        {
            stage: 'source',
            path: '',
            reason: 'invalid_jsonc',
            line: 2,
            column: expect.any(Number) as number,
        },
    ]);
    expect(error.message).not.toContain(SECRET);
});

it('keeps sentinels out of the error message and the issues', async () => {
    const { service } = await open();
    const sentinel = 'private-sentinel';
    const bad = file(
        [
            {
                name: 'review',
                harness: 'claude',
                useWhen: 'Review',
                instructions: SECRET,
                [sentinel]: SECRET,
            },
        ],
        {
            [`${sentinel}-top`]: 1,
            callers: { [sentinel]: { agents: { 'Private Sentinel': { harness: 'claude' } } } },
        },
    );
    const error = await expectRejection(service.importDelegationSettings(request(bad)));
    const text = JSON.stringify(error.details) + error.message;
    expect(text).not.toMatch(/sentinel|Sentinel|Synthetic/u);
    expect(error.details.issues).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ path: 'agents.0', reason: 'unknown_field' }),
        ]),
    );
});

it('reports result-stage issues for the merged settings', async () => {
    const { service } = await open();
    const letter = (offset: number) => String.fromCodePoint(97 + offset);
    const many = (count: number, prefix: string) =>
        Array.from({ length: count }, (_, index) => ({
            name: `${prefix}-${letter(index % 26)}${letter(Math.floor(index / 26))}`,
            harness: 'claude',
            useWhen: 'Use',
        }));
    const existing = file(many(32, 'old'));
    await service.importDelegationSettings(request(existing, { dryRun: false }));
    const incoming = file(many(1, 'new'));
    const error = await expectRejection(service.importDelegationSettings(request(incoming)));
    expect(error.details.issues).toEqual([
        expect.objectContaining({ stage: 'result', reason: 'too_many' }),
    ]);
    expect(
        (await service.importDelegationSettings(request(incoming, { mode: 'replace' })))
            .presetNames,
    ).toEqual(['new-aa']);
});

it('rejects a merged settings file over the size ceiling before it is prepared', async () => {
    const { service } = await open();
    const padding = 'x'.repeat(MAX_CONFIGURATION_SOURCE_BYTES - 1_000);
    await service.updateSettings(`{"terminal.fontSize": 17}\n// ${padding}\n`);
    const before = await readFile(service.settingsPath, 'utf8');
    const source = file([
        { name: 'review', harness: 'claude', useWhen: 'Review', instructions: 'y'.repeat(4_000) },
    ]);
    const error = await expectRejection(
        service.importDelegationSettings(request(source, { dryRun: false })),
    );
    expect(error).toMatchObject({ code: 'VALIDATION' });
    expect(error.details.issues).toEqual([{ stage: 'result', path: '', reason: 'too_large' }]);
    expect(await readFile(service.settingsPath, 'utf8')).toBe(before);
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
