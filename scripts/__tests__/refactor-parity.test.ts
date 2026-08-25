import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compareReceipts, privacyViolations } from '../refactor-parity/compare';
import type {
    IntentionalDifferences,
    NormalizationRules,
    ParityReceipt,
    ScenarioCatalog,
} from '../refactor-parity/contracts';
import { recordBaseline, verifyBaseline } from '../refactor-parity/core';

const temporaryDirectories: string[] = [];
const normalization: NormalizationRules = { rules: [], schemaVersion: 1 };
const emptyAllowlist: IntentionalDifferences = { entries: [], schemaVersion: 1 };

async function createTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-refactor-parity-'));
    temporaryDirectories.push(directory);
    return directory;
}

async function writeJson(path: string, value: unknown): Promise<void> {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createReceipt(role: 'before' | 'candidate' = 'before'): ParityReceipt {
    return {
        artifactRole: role,
        environment: {
            appVersion: '0.0.18',
            architecture: 'arm64',
            configurationFingerprint: 'configuration-v1',
            fixtureVersion: 'fixture-v1',
            font: 'system-monospace',
            locale: 'en-US',
            operatingSystem: 'macOS 15.6',
            persistedStateFingerprint: 'empty-profile-v1',
            protocolVersion: 1,
            shell: '/bin/zsh',
            theme: 'dark',
            timeZone: 'UTC',
            viewport: { height: 900, width: 1440 },
        },
        scenarios: [
            {
                id: 'protocol-request',
                metrics: {
                    latency: {
                        absoluteCeiling: 20,
                        maxRegressionRatio: 0.2,
                        samples: [10, 11, 12],
                        statistic: 'p95',
                        unit: 'ms',
                    },
                },
                semantic: {
                    cli: { exitCode: 0, outputKind: 'json' },
                    error: { code: 'PROJECT_NOT_FOUND', retryable: false },
                    events: ['project.changed', 'session.changed'],
                    persistence: { projects: 1, sessions: 1 },
                    processId: 42,
                    terminal: { exitStatus: null, generation: 1 },
                    visual: { activePanel: 'terminal', selectedSession: true },
                },
                status: 'pass',
            },
        ],
        schemaVersion: 1,
        source: {
            appVersion: '0.0.18',
            buildId: role === 'before' ? 'before-build' : 'candidate-build',
            commit: role === 'before' ? '1'.repeat(40) : '2'.repeat(40),
            protocolVersion: 1,
            tree: role === 'before' ? '3'.repeat(40) : '4'.repeat(40),
        },
    };
}

function createCatalog(): ScenarioCatalog {
    return {
        scenarios: [
            {
                deterministicReason: 'The fixture has one deterministic request and response.',
                environmentChecks: ['fixtureVersion'],
                evidenceConstraints: ['No source or terminal content'],
                evidenceMode: 'non-visual',
                id: 'protocol-request',
                surface: 'Protocol',
            },
        ],
        schemaVersion: 1,
    };
}

afterEach(async () => {
    const directories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(
        directories.map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe('architecture refactor parity baseline', () => {
    it('archives an immutable artifact and detects later artifact tampering', async () => {
        const directory = await createTemporaryDirectory();
        const artifact = join(directory, 'Caxri.app');
        await mkdir(join(artifact, 'Contents'), { recursive: true });
        await writeFile(join(artifact, 'Contents', 'Info.plist'), 'fixture', 'utf8');
        await writeFile(join(artifact, 'Contents', 'fixture-executable'), '#!/bin/sh\nexit 0\n');
        await chmod(join(artifact, 'Contents', 'fixture-executable'), 0o755);
        await symlink('Info.plist', join(artifact, 'Contents', 'Current'));
        const catalog = join(directory, 'catalog.json');
        const receipt = join(directory, 'receipt.json');
        const normalizations = join(directory, 'normalization.json');
        const allowlist = join(directory, 'allowlist.json');
        await Promise.all([
            writeJson(catalog, createCatalog()),
            writeJson(receipt, createReceipt()),
            writeJson(normalizations, normalization),
            writeJson(allowlist, emptyAllowlist),
        ]);

        const baseline = await recordBaseline({
            allowlistPath: allowlist,
            artifactPath: artifact,
            baselineId: 'before-1111111',
            catalogPath: catalog,
            normalizationPath: normalizations,
            outputRoot: join(directory, 'baselines'),
            receiptPath: receipt,
            startupExecutableRelativePath: 'Contents/fixture-executable',
        });

        await expect(
            recordBaseline({
                allowlistPath: allowlist,
                artifactPath: artifact,
                baselineId: 'before-1111111',
                catalogPath: catalog,
                normalizationPath: normalizations,
                outputRoot: join(directory, 'baselines'),
                receiptPath: receipt,
                startupExecutableRelativePath: 'Contents/fixture-executable',
            }),
        ).rejects.toThrow('Baseline already exists and is immutable');
        expect((await verifyBaseline(baseline)).failures).toEqual([]);

        await writeFile(join(baseline, 'artifact', 'Contents', 'Info.plist'), 'tampered', 'utf8');
        expect((await verifyBaseline(baseline)).failures).toContain(
            'Archived artifact hash or file metadata changed',
        );
    });

    it('rejects missing scenarios and privacy-sensitive evidence', async () => {
        const directory = await createTemporaryDirectory();
        const artifact = join(directory, 'artifact');
        await mkdir(artifact);
        await writeFile(join(artifact, 'app'), 'fixture', 'utf8');
        const receiptValue = createReceipt();
        receiptValue.scenarios[0].semantic = {
            terminalOutput: 'must never persist',
        } as never;
        const catalog = join(directory, 'catalog.json');
        const receipt = join(directory, 'receipt.json');
        const normalizations = join(directory, 'normalization.json');
        const allowlist = join(directory, 'allowlist.json');
        await Promise.all([
            writeJson(catalog, { ...createCatalog(), scenarios: [] }),
            writeJson(receipt, receiptValue),
            writeJson(normalizations, normalization),
            writeJson(allowlist, emptyAllowlist),
        ]);

        await expect(
            recordBaseline({
                allowlistPath: allowlist,
                artifactPath: artifact,
                baselineId: 'invalid',
                catalogPath: catalog,
                normalizationPath: normalizations,
                outputRoot: join(directory, 'baselines'),
                receiptPath: receipt,
            }),
        ).rejects.toThrow();
        expect(privacyViolations(receiptValue)).toContain('$.scenarios[0].semantic.terminalOutput');
    });
});

describe('architecture refactor parity comparison', () => {
    it.each([
        [
            'stable error code',
            (receipt: ParityReceipt) =>
                (receipt.scenarios[0].semantic.error = { code: 'INTERNAL' }),
        ],
        [
            'public event order',
            (receipt: ParityReceipt) =>
                (receipt.scenarios[0].semantic.events = ['session.changed', 'project.changed']),
        ],
        [
            'CLI exit code',
            (receipt: ParityReceipt) => (receipt.scenarios[0].semantic.cli = { exitCode: 1 }),
        ],
        [
            'Terminal status',
            (receipt: ParityReceipt) =>
                (receipt.scenarios[0].semantic.terminal = { exitStatus: 1, generation: 1 }),
        ],
        [
            'persistence projection',
            (receipt: ParityReceipt) =>
                (receipt.scenarios[0].semantic.persistence = { projects: 0, sessions: 0 }),
        ],
        [
            'visible state',
            (receipt: ParityReceipt) =>
                (receipt.scenarios[0].semantic.visual = {
                    activePanel: 'editor',
                    selectedSession: false,
                }),
        ],
    ])('fails closed for a seeded %s mutation', (_name, mutate) => {
        const baseline = createReceipt();
        const candidate = createReceipt('candidate');
        mutate(candidate);

        const result = compareReceipts(baseline, candidate, normalization, emptyAllowlist);

        expect(result.status).toBe('fail');
        expect(result.failures).toContainEqual(expect.stringContaining('changed semantic'));
    });

    it('normalizes only declared wildcard paths', () => {
        const baseline = createReceipt();
        const candidate = createReceipt('candidate');
        candidate.scenarios[0].semantic.processId = 99;

        expect(compareReceipts(baseline, candidate, normalization, emptyAllowlist).status).toBe(
            'fail',
        );
        expect(
            compareReceipts(
                baseline,
                candidate,
                {
                    rules: [{ kind: 'pid', path: '/scenarios/*/semantic/processId' }],
                    schemaVersion: 1,
                },
                emptyAllowlist,
            ).status,
        ).toBe('pass');
    });

    it('accepts only an exact reviewed intentional difference', () => {
        const baseline = createReceipt();
        const candidate = createReceipt('candidate');
        candidate.scenarios[0].semantic.cli = { exitCode: 1, outputKind: 'json' };
        const allowlist: IntentionalDifferences = {
            entries: [
                {
                    after: 1,
                    before: 0,
                    expiresAfterBatch: 'A2a',
                    issue: 374,
                    path: 'semantic.cli.exitCode',
                    rationale: 'Seeded comparator contract test only.',
                    scenarioId: 'protocol-request',
                    visibility: 'internal',
                },
            ],
            schemaVersion: 1,
        };

        const result = compareReceipts(baseline, candidate, normalization, allowlist, 'A2a');

        expect(result.status).toBe('pass');
        expect(result.allowedDifferences).toHaveLength(1);
        allowlist.entries[0].after = 2;
        expect(compareReceipts(baseline, candidate, normalization, allowlist, 'A2a').status).toBe(
            'fail',
        );
        allowlist.entries[0].after = 1;
        expect(
            compareReceipts(baseline, candidate, normalization, allowlist, 'A2b').failures,
        ).toContain('Intentional difference expired after A2a');
    });

    it('fails when a performance budget regresses or a scenario is missing', () => {
        const baseline = createReceipt();
        const candidate = createReceipt('candidate');
        candidate.scenarios[0].metrics!.latency.samples = [15, 16, 17];

        const regression = compareReceipts(baseline, candidate, normalization, emptyAllowlist);
        expect(regression.failures).toContain(
            'protocol-request: performance metric latency regressed beyond ratio budget',
        );

        candidate.scenarios = [];
        expect(
            compareReceipts(baseline, candidate, normalization, emptyAllowlist).failures,
        ).toContain('protocol-request: candidate receipt is missing');
    });
});
