import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    preparePublicE2EReceipts,
    publicE2EPoolReceiptSchema,
    toPublicAgentChatSwitchReceipt,
    toPublicE2EPoolReceipt,
} from '../prepare-public-e2e-receipts';
import { createE2EPoolReceipt, stableErrorIdentity } from '../reporters/e2e-receipt-reporter';

const roots: string[] = [];

afterEach(async () => {
    const cleanupRoots = [...roots];
    roots.length = 0;
    await Promise.all(cleanupRoots.map((root) => rm(root, { force: true, recursive: true })));
});

async function fixtureDirectories(): Promise<{
    outputDirectory: string;
    root: string;
    sourceDirectory: string;
}> {
    const root = await mkdtemp(join(tmpdir(), 'caxri-public-e2e-receipts-'));
    roots.push(root);
    const sourceDirectory = join(root, 'receipts');
    const outputDirectory = join(root, 'public-receipts');
    await mkdir(sourceDirectory, { recursive: true });
    return { outputDirectory, root, sourceDirectory };
}

function failingPoolReceipt() {
    return createE2EPoolReceipt({
        finishedAt: '2026-01-01T00:00:01.000Z',
        pool: 'parallel-safe',
        startedAt: '2026-01-01T00:00:00.000Z',
        tests: [
            {
                artifacts: ['test-results/parallel-safe/case/trace.zip'],
                durationMs: 250,
                errorIdentity: stableErrorIdentity('synthetic terminal output must stay private'),
                id: 'private suite > private title',
                location: 'e2e/example.e2e.ts:10:2',
                title: 'private title',
                verdict: 'fail',
            },
        ],
    });
}

function rendererPerformanceReceipt() {
    const surface = {
        actualDurationMaxMs: 0,
        actualDurationP50Ms: 0,
        actualDurationP95Ms: 0,
        actualDurationTotalMs: 0,
        baseDurationMaxMs: 0,
        profiledRenderCount: 0,
    };
    const stage = { count: 0, maxDurationMs: 0, totalDurationMs: 0 };
    return {
        action: 'session.switch',
        buildMode: 'profiling',
        capabilities: {
            eventTiming: 'unavailable',
            longAnimationFrame: 'unavailable',
            reactProfiler: 'disabled',
        },
        diagnosticId: 'd66947a8-0da0-4a4b-8629-a7694116d8e5',
        documentFocused: false,
        documentVisible: true,
        durationMs: 0,
        entry: 'workbench',
        focusInterrupted: false,
        frames: {
            estimatedRefreshIntervalMs: 0,
            intervalP50Ms: 0,
            intervalP95Ms: 0,
            maxIntervalMs: 0,
            missedFrameCount: 0,
            sampleCount: 0,
        },
        interactions: {
            count: 0,
            maxDurationMs: 0,
            maxInputDelayMs: 0,
            maxPresentationDelayMs: 0,
            maxProcessingDurationMs: 0,
        },
        kind: 'renderer-performance-scenario',
        longAnimationFrames: {
            count: 0,
            maxBlockingDurationMs: 0,
            maxDurationMs: 0,
            maxStyleAndLayoutDurationMs: 0,
            totalBlockingDurationMs: 0,
            totalDurationMs: 0,
        },
        react: {
            actualDurationMaxMs: 0,
            actualDurationP50Ms: 0,
            actualDurationP95Ms: 0,
            baseDurationMaxMs: 0,
            commitCount: 0,
            mountRenderCount: 0,
            nestedUpdateRenderCount: 0,
            profiledRenderCount: 0,
            surfaces: {
                'primary-sidebar': surface,
                'secondary-sidebar': surface,
                'workbench': surface,
            },
            updateRenderCount: 0,
        },
        requests: {
            appBootstrap: { count: 0, maxDurationMs: 0, totalDurationMs: 0 },
            sessionSelect: { count: 0, maxDurationMs: 0, totalDurationMs: 0 },
        },
        scenarioId: '08f3dd5f-5c18-49e2-bc25-e46262ec624d',
        terminals: {
            attachedCount: 0,
            reusedCount: 0,
            stages: { snapshotReplay: stage, webglAttach: stage, xtermCreate: stage },
        },
        truncated: false,
        visibilityInterrupted: false,
    };
}

async function expectRejectedReceipt(value: unknown): Promise<void> {
    const { outputDirectory, sourceDirectory } = await fixtureDirectories();
    const inputPath = join(sourceDirectory, 'parallel-safe.json');
    await writeFile(inputPath, JSON.stringify(value), 'utf8');
    await expect(preparePublicE2EReceipts({ outputDirectory, sourceDirectory })).rejects.toThrow();
    await expect(access(outputDirectory)).rejects.toThrow();
}

function chatSwitchSummary() {
    const distribution = { p50: 40, p95: 60, max: 70 };
    const surface = { renders: distribution, actualDurationMs: distribution };
    return {
        iterations: 20,
        readableMs: distribution,
        interactiveMs: distribution,
        shownMs: distribution,
        maxFrameGapMs: distribution,
        longestAnimationFrameMs: { p50: null, p95: null, max: null },
        readRequests: { p50: 0, p95: 0, max: 0 },
        react: {
            commitCount: distribution,
            surfaces: {
                'primary-sidebar': surface,
                'workbench': surface,
                'secondary-sidebar': surface,
            },
        },
    };
}

function agentChatSwitchReceipt() {
    return {
        kind: 'agent-chat-session-switch',
        turnCount: 16,
        scenarios: {
            keptAlive: chatSwitchSummary(),
            cached: chatSwitchSummary(),
            uncached: chatSwitchSummary(),
            cold: chatSwitchSummary(),
        },
        hiddenStreaming: {
            commitCount: 8,
            workbench: { renders: 5, actualDurationMs: 0.6 },
            keptAliveStreaming: chatSwitchSummary(),
        },
    };
}

describe('public E2E receipts', () => {
    it('projects only closed failure metadata and ignores every raw diagnostic file', async () => {
        const { outputDirectory, sourceDirectory } = await fixtureDirectories();
        const poolReceipt = JSON.stringify(failingPoolReceipt());
        await Promise.all([
            writeFile(join(sourceDirectory, 'parallel-safe.json'), poolReceipt, 'utf8'),
            writeFile(join(sourceDirectory, 'trace.zip'), 'synthetic source', 'utf8'),
            writeFile(join(sourceDirectory, 'failure.png'), 'synthetic screenshot', 'utf8'),
            writeFile(join(sourceDirectory, 'error-context.md'), 'synthetic DOM', 'utf8'),
            writeFile(join(sourceDirectory, 'runtime.jsonl'), 'synthetic Terminal output', 'utf8'),
            writeFile(join(sourceDirectory, 'source.ts'), 'synthetic repository source', 'utf8'),
        ]);

        await expect(
            preparePublicE2EReceipts({ outputDirectory, sourceDirectory }),
        ).resolves.toEqual(['parallel-safe.json']);
        expect(await readdir(outputDirectory)).toEqual(['parallel-safe.json']);

        const raw = await readFile(join(outputDirectory, 'parallel-safe.json'), 'utf8');
        const receipt = publicE2EPoolReceiptSchema.parse(JSON.parse(raw));
        const errorIdentity = stableErrorIdentity('synthetic terminal output must stay private');
        expect(receipt.failures).toEqual([
            {
                classification: 'stable-error-hash',
                errorIdentity,
                spec: 'e2e/example.e2e.ts',
                verdict: 'fail',
            },
        ]);
        expect(receipt.specs).toEqual([
            {
                durationMs: 250,
                path: 'e2e/example.e2e.ts',
                testCount: 1,
                verdict: 'fail',
            },
        ]);
        for (const forbidden of [
            'artifacts',
            'private title',
            'synthetic terminal output',
            'trace.zip',
        ]) {
            expect(raw).not.toContain(forbidden);
        }
    });

    it('stages a strictly validated Renderer performance receipt', async () => {
        const { outputDirectory, sourceDirectory } = await fixtureDirectories();
        const rendererReceipt = rendererPerformanceReceipt();
        const poolReceipt = JSON.stringify(failingPoolReceipt());
        await Promise.all([
            writeFile(join(sourceDirectory, 'parallel-safe.json'), poolReceipt, 'utf8'),
            writeFile(
                join(sourceDirectory, 'renderer-performance.json'),
                JSON.stringify(rendererReceipt),
                'utf8',
            ),
        ]);

        await expect(
            preparePublicE2EReceipts({ outputDirectory, sourceDirectory }),
        ).resolves.toEqual(['parallel-safe.json', 'renderer-performance.json']);
        const outputPath = join(outputDirectory, 'renderer-performance.json');
        const output = await readFile(outputPath, 'utf8');
        expect(JSON.parse(output)).toEqual(rendererReceipt);
    });

    it('publishes the Agent Chat switch distributions and keeps the per-switch samples private', async () => {
        const { outputDirectory, sourceDirectory } = await fixtureDirectories();
        const receipt = agentChatSwitchReceipt();
        await writeFile(
            join(sourceDirectory, 'agent-chat-session-switch.json'),
            JSON.stringify({ ...receipt, samples: { keptAlive: [{ contentMs: 40 }] } }),
            'utf8',
        );

        await expect(
            preparePublicE2EReceipts({ outputDirectory, sourceDirectory }),
        ).resolves.toEqual(['agent-chat-session-switch.json']);
        const output = await readFile(
            join(outputDirectory, 'agent-chat-session-switch.json'),
            'utf8',
        );
        expect(JSON.parse(output)).toEqual(receipt);
    });

    it('rejects an Agent Chat switch receipt carrying text', () => {
        const receipt = agentChatSwitchReceipt();
        expect(() =>
            toPublicAgentChatSwitchReceipt({
                ...receipt,
                scenarios: {
                    ...receipt.scenarios,
                    cached: { ...receipt.scenarios.cached, lastMessage: 'private reply' },
                },
            }),
        ).toThrow();
    });

    it('normalizes census line selectors before publishing abort metadata', () => {
        const receipt = {
            ...failingPoolReceipt(),
            abortedInvocations: [
                {
                    exitCode: 1,
                    specs: ['e2e/example.e2e.ts:12', 'e2e/second-example.e2e.ts:20:4'],
                },
            ],
            missingSpecs: ['e2e/example.e2e.ts:12'],
        };

        const publicReceipt = toPublicE2EPoolReceipt(receipt);
        expect(publicReceipt.abortedInvocations).toEqual([
            {
                exitCode: 1,
                specs: ['e2e/example.e2e.ts', 'e2e/second-example.e2e.ts'],
            },
        ]);
        expect(publicReceipt.missingSpecs).toEqual(['e2e/example.e2e.ts']);
    });

    it('publishes a closed classification when Playwright provides no error text', () => {
        const receipt = failingPoolReceipt();
        receipt.tests[0].errorIdentity = null;
        receipt.failureGroups = [];

        expect(toPublicE2EPoolReceipt(receipt).failures).toEqual([
            {
                classification: 'missing-error',
                spec: 'e2e/example.e2e.ts',
                verdict: 'fail',
            },
        ]);
    });

    it('accepts a test that passed on retry and keeps its first failure private', async () => {
        const { outputDirectory, sourceDirectory } = await fixtureDirectories();
        const receipt = failingPoolReceipt();
        receipt.tests[0].firstFailure = {
            errorIdentity: receipt.tests[0].errorIdentity,
            verdict: 'fail',
        };
        receipt.tests[0].errorIdentity = null;
        receipt.tests[0].verdict = 'pass';
        receipt.failureGroups = [];
        receipt.pool = 'release-packaged';
        await writeFile(
            join(sourceDirectory, 'release-packaged.json'),
            JSON.stringify(receipt),
            'utf8',
        );

        await expect(
            preparePublicE2EReceipts({ outputDirectory, sourceDirectory }),
        ).resolves.toEqual(['release-packaged.json']);
        const raw = await readFile(join(outputDirectory, 'release-packaged.json'), 'utf8');
        expect(publicE2EPoolReceiptSchema.parse(JSON.parse(raw)).failures).toEqual([]);
        expect(raw).not.toContain('firstFailure');
    });

    it('rejects extra text fields, absolute paths, traversal, and malformed JSON', async () => {
        const receipt = failingPoolReceipt();
        const invalid: unknown[] = [
            { ...receipt, terminalOutput: 'secret' },
            { ...receipt, pool: 'control' },
            {
                ...receipt,
                tests: [{ ...receipt.tests[0], stdout: 'secret' }],
            },
            {
                ...receipt,
                tests: [{ ...receipt.tests[0], location: '/Users/private/source.e2e.ts:1:1' }],
            },
            {
                ...receipt,
                tests: [{ ...receipt.tests[0], location: '../private/source.e2e.ts:1:1' }],
            },
        ];
        await Promise.all(invalid.map((value) => expectRejectedReceipt(value)));

        const { outputDirectory, sourceDirectory } = await fixtureDirectories();
        const malformedPath = join(sourceDirectory, 'parallel-safe.json');
        await writeFile(malformedPath, '{', 'utf8');
        await expect(
            preparePublicE2EReceipts({ outputDirectory, sourceDirectory }),
        ).rejects.toThrow();
        await expect(access(outputDirectory)).rejects.toThrow();
    });

    it('removes all staged output when a later known receipt is invalid', async () => {
        const { outputDirectory, sourceDirectory } = await fixtureDirectories();
        await writeFile(
            join(sourceDirectory, 'parallel-safe.json'),
            JSON.stringify(failingPoolReceipt()),
            'utf8',
        );
        await writeFile(
            join(sourceDirectory, 'renderer-performance.json'),
            JSON.stringify({ kind: 'renderer-performance-scenario', source: 'private source' }),
            'utf8',
        );

        await expect(
            preparePublicE2EReceipts({ outputDirectory, sourceDirectory }),
        ).rejects.toThrow();
        await expect(access(outputDirectory)).rejects.toThrow();
    });

    it('rejects a public projection with any additional field', () => {
        expect(() =>
            publicE2EPoolReceiptSchema.parse({
                ...toPublicE2EPoolReceipt(failingPoolReceipt()),
                message: 'private failure text',
            }),
        ).toThrow();
    });
});
