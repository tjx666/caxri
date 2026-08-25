/* eslint-disable unicorn/max-nested-calls -- Zod schemas intentionally compose validation inline. */
import { z } from 'zod';

export const scenarioStatusSchema = z.enum(['pass', 'fail', 'blocked', 'invalid']);

export const sourceIdentitySchema = z.object({
    appVersion: z.string().min(1),
    buildId: z.string().min(1),
    commit: z.string().regex(/^[a-f\d]{40}$/u),
    protocolVersion: z.number().int().nonnegative(),
    tree: z.string().regex(/^[a-f\d]{40}$/u),
});

export const environmentSchema = z.object({
    appVersion: z.string().min(1),
    architecture: z.string().min(1),
    configurationFingerprint: z.string().min(1),
    fixtureVersion: z.string().min(1),
    font: z.string().min(1),
    locale: z.string().min(1),
    operatingSystem: z.string().min(1),
    persistedStateFingerprint: z.string().min(1),
    protocolVersion: z.number().int().nonnegative(),
    shell: z.string().min(1),
    theme: z.string().min(1),
    timeZone: z.string().min(1),
    viewport: z.object({ height: z.number().int().positive(), width: z.number().int().positive() }),
});

export const performanceMetricSchema = z.object({
    absoluteCeiling: z.number().nonnegative().optional(),
    maxRegressionRatio: z.number().nonnegative(),
    samples: z.array(z.number().nonnegative()).min(1).max(100),
    statistic: z.enum(['max', 'p50', 'p95']),
    unit: z.string().min(1),
});

const passEvidenceSchema = z.literal('pass');
const boundedEvidenceNameSchema = z.string().min(1).max(64);
const semanticEvidenceSchema = z
    .object({
        activeProjectWatchers: z.number().int().nonnegative().optional(),
        behaviorTests: passEvidenceSchema.optional(),
        behaviors: z.array(boundedEvidenceNameSchema).min(1).max(100).optional(),
        bundledPackageEvidence: passEvidenceSchema.optional(),
        cli: z
            .object({
                exitCode: z.number().int(),
                outputKind: boundedEvidenceNameSchema.optional(),
            })
            .strict()
            .optional(),
        electronEvidence: passEvidenceSchema.optional(),
        error: z
            .object({
                code: boundedEvidenceNameSchema,
                retryable: z.boolean().optional(),
            })
            .strict()
            .optional(),
        events: z.array(boundedEvidenceNameSchema).max(100).optional(),
        fixtureAgentEvidence: passEvidenceSchema.optional(),
        fixtureElectronEvidence: passEvidenceSchema.optional(),
        highFrequencyRequestLogs: z.number().int().nonnegative().optional(),
        logicalProjectionEvidence: passEvidenceSchema.optional(),
        packagedSmoke: passEvidenceSchema.optional(),
        persistence: z.record(boundedEvidenceNameSchema, z.number().int().nonnegative()).optional(),
        processId: z.number().int().nonnegative().optional(),
        repetitions: z.number().int().positive().max(100).optional(),
        requestFailures: z.number().int().nonnegative().optional(),
        terminal: z
            .object({
                exitStatus: z.number().int().nullable(),
                generation: z.number().int().nonnegative(),
            })
            .strict()
            .optional(),
        viewport: z
            .string()
            .regex(/^\d{2,5}x\d{2,5}$/u)
            .optional(),
        visual: z
            .object({
                activePanel: boundedEvidenceNameSchema,
                selectedSession: z.boolean(),
            })
            .strict()
            .optional(),
        watcherSetupFailures: z.number().int().nonnegative().optional(),
    })
    .strict();

export const scenarioReceiptSchema = z.object({
    id: z.string().regex(/^[a-z\d][a-z\d-]*$/u),
    metrics: z.record(z.string().min(1), performanceMetricSchema).optional(),
    semantic: semanticEvidenceSchema,
    status: scenarioStatusSchema,
});

export const parityReceiptSchema = z.object({
    artifactRole: z.enum(['before', 'candidate']),
    environment: environmentSchema,
    scenarios: z.array(scenarioReceiptSchema).min(1),
    schemaVersion: z.literal(1),
    source: sourceIdentitySchema,
});

export const scenarioCatalogSchema = z.object({
    scenarios: z
        .array(
            z.object({
                deterministicReason: z.string().min(8),
                environmentChecks: z.array(z.string().min(1)).min(1),
                evidenceConstraints: z.array(z.string().min(1)).min(1),
                evidenceMode: z.enum(['visual', 'non-visual', 'mixed']),
                id: z.string().regex(/^[a-z\d][a-z\d-]*$/u),
                surface: z.string().min(1),
            }),
        )
        .min(1),
    schemaVersion: z.literal(1),
});

export const normalizationSchema = z.object({
    rules: z.array(
        z.object({
            kind: z.enum([
                'build-id',
                'connection-id',
                'duration',
                'pid',
                'port',
                'random-id',
                'temporary-path',
                'timestamp',
                'unordered-array',
            ]),
            path: z.string().startsWith('/'),
        }),
    ),
    schemaVersion: z.literal(1),
});

export const intentionalDifferenceSchema = z.object({
    entries: z.array(
        z.object({
            after: z.unknown(),
            before: z.unknown(),
            expiresAfterBatch: z.string().min(1),
            issue: z.number().int().positive(),
            path: z.string().min(1),
            rationale: z.string().min(8),
            scenarioId: z.string().min(1),
            visibility: z.enum(['artifact', 'internal']),
        }),
    ),
    schemaVersion: z.literal(1),
});

export type EnvironmentFingerprint = z.infer<typeof environmentSchema>;
export type IntentionalDifferences = z.infer<typeof intentionalDifferenceSchema>;
export type NormalizationRules = z.infer<typeof normalizationSchema>;
export type ParityReceipt = z.infer<typeof parityReceiptSchema>;
export type PerformanceMetric = z.infer<typeof performanceMetricSchema>;
export type ScenarioCatalog = z.infer<typeof scenarioCatalogSchema>;
export type ScenarioReceipt = z.infer<typeof scenarioReceiptSchema>;

export interface ArtifactFileReceipt {
    kind: 'file' | 'symlink';
    mode: number;
    path: string;
    sha256: string;
    size: number;
    target?: string;
}

export interface RefactorBaselineManifest {
    allowlistSha256: string;
    artifact: {
        aggregateSha256: string;
        files: ArtifactFileReceipt[];
        relativePath: string;
    };
    baselineId: string;
    catalogSha256: string;
    createdAt: string;
    environment: EnvironmentFingerprint;
    normalizationSha256: string;
    receiptSha256: string;
    scenarioIds: string[];
    schemaVersion: 1;
    source: z.infer<typeof sourceIdentitySchema>;
    startupProbe?: {
        arguments: string[];
        executableRelativePath: string;
    };
}

export interface ParityDifference {
    after: unknown;
    before: unknown;
    path: string;
    scenarioId: string;
}

export interface ParityComparisonSummary {
    allowedDifferences: ParityDifference[];
    candidateCommit: string;
    failures: string[];
    passedScenarios: string[];
    scenarios: Array<{
        differences: ParityDifference[];
        failures: string[];
        id: string;
        status: z.infer<typeof scenarioStatusSchema>;
    }>;
    schemaVersion: 1;
    status: z.infer<typeof scenarioStatusSchema>;
}

const artifactFileReceiptSchema = z.object({
    kind: z.enum(['file', 'symlink']),
    mode: z.number().int().nonnegative(),
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f\d]{64}$/u),
    size: z.number().int().nonnegative(),
    target: z.string().optional(),
});

export const refactorBaselineManifestSchema = z.object({
    allowlistSha256: z.string().regex(/^[a-f\d]{64}$/u),
    artifact: z.object({
        aggregateSha256: z.string().regex(/^[a-f\d]{64}$/u),
        files: z.array(artifactFileReceiptSchema).min(1),
        relativePath: z.string().min(1),
    }),
    baselineId: z.string().regex(/^[a-z\d][a-z\d-]*$/u),
    catalogSha256: z.string().regex(/^[a-f\d]{64}$/u),
    createdAt: z.iso.datetime(),
    environment: environmentSchema,
    normalizationSha256: z.string().regex(/^[a-f\d]{64}$/u),
    receiptSha256: z.string().regex(/^[a-f\d]{64}$/u),
    scenarioIds: z.array(z.string().min(1)).min(1),
    schemaVersion: z.literal(1),
    source: sourceIdentitySchema,
    startupProbe: z
        .object({
            arguments: z.array(z.string()),
            executableRelativePath: z.string().min(1),
        })
        .optional(),
});
/* eslint-enable unicorn/max-nested-calls */
