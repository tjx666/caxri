import { execFile } from 'node:child_process';
import { cp } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { writeJsonAtomic } from '../atomic-json';
import { compareReceipts, privacyViolations } from './compare';
import type {
    IntentionalDifferences,
    NormalizationRules,
    ParityComparisonSummary,
    ParityReceipt,
    RefactorBaselineManifest,
    ScenarioCatalog,
} from './contracts';
import {
    intentionalDifferenceSchema,
    normalizationSchema,
    parityReceiptSchema,
    refactorBaselineManifestSchema,
    scenarioCatalogSchema,
} from './contracts';
import { archiveArtifact, publishBaseline, readJson, sha256File, verifyArtifactFiles } from './io';

export interface RecordBaselineOptions {
    allowlistPath: string;
    artifactPath: string;
    baselineId: string;
    catalogPath: string;
    normalizationPath: string;
    outputRoot: string;
    receiptPath: string;
    startupExecutableRelativePath?: string;
}

const execFileAsync = promisify(execFile);

function assertRelativePath(path: string, description: string): string {
    const normalizedPath = normalize(path);
    if (normalizedPath === '..' || isAbsolute(path) || normalizedPath.startsWith(`..${sep}`)) {
        throw new Error(`${description} must stay inside the baseline directory`);
    }
    return normalizedPath;
}

async function verifyStartupProbe(
    baselineDirectory: string,
    manifest: RefactorBaselineManifest,
): Promise<string[]> {
    if (!manifest.startupProbe) return [];
    const executable = join(
        baselineDirectory,
        assertRelativePath(
            manifest.startupProbe.executableRelativePath,
            'Baseline startup executable path',
        ),
    );
    const environmentEntries = ['LANG', 'LC_ALL', 'PATH', 'SHELL', 'TMPDIR']
        .map((key) => [key, process.env[key]])
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    try {
        await execFileAsync(executable, manifest.startupProbe.arguments, {
            encoding: 'utf8',
            env: { ...Object.fromEntries(environmentEntries), ELECTRON_RUN_AS_NODE: '1' },
            maxBuffer: 64 * 1024,
            timeout: 5_000,
        });
        return [];
    } catch {
        return ['Archived artifact startup probe failed'];
    }
}

export interface VerifiedBaseline {
    allowlist: IntentionalDifferences;
    catalog: ScenarioCatalog;
    failures: string[];
    manifest: RefactorBaselineManifest;
    normalization: NormalizationRules;
    receipt: ParityReceipt;
}

function duplicateIds(values: readonly string[]): string[] {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const value of values) {
        if (seen.has(value)) duplicates.add(value);
        seen.add(value);
    }
    return [...duplicates];
}

function coverageFailures(catalog: ScenarioCatalog, receipt: ParityReceipt): string[] {
    const catalogIds = catalog.scenarios.map((scenario) => scenario.id);
    const receiptIds = receipt.scenarios.map((scenario) => scenario.id);
    const catalogSet = new Set(catalogIds);
    const receiptSet = new Set(receiptIds);
    return [
        ...duplicateIds(catalogIds).map((id) => `Duplicate catalog scenario: ${id}`),
        ...duplicateIds(receiptIds).map((id) => `Duplicate receipt scenario: ${id}`),
        ...catalogIds.filter((id) => !receiptSet.has(id)).map((id) => `Missing receipt: ${id}`),
        ...receiptIds.filter((id) => !catalogSet.has(id)).map((id) => `Unknown receipt: ${id}`),
    ];
}

async function loadInputs(options: RecordBaselineOptions): Promise<{
    allowlist: IntentionalDifferences;
    catalog: ScenarioCatalog;
    normalization: NormalizationRules;
    receipt: ParityReceipt;
}> {
    const [catalogValue, receiptValue, normalizationValue, allowlistValue] = await Promise.all([
        readJson(options.catalogPath),
        readJson(options.receiptPath),
        readJson(options.normalizationPath),
        readJson(options.allowlistPath),
    ]);
    const catalog = scenarioCatalogSchema.parse(catalogValue);
    const receipt = parityReceiptSchema.parse(receiptValue);
    const normalization = normalizationSchema.parse(normalizationValue);
    const allowlist = intentionalDifferenceSchema.parse(allowlistValue);
    const failures = [
        ...coverageFailures(catalog, receipt),
        ...privacyViolations(receipt).map((path) => `Evidence contains prohibited ${path}`),
        ...receipt.scenarios
            .filter((scenario) => scenario.status !== 'pass')
            .map((scenario) => `Baseline scenario is not pass: ${scenario.id}`),
    ];
    if (receipt.artifactRole !== 'before')
        failures.push('Baseline receipt artifactRole must be before');
    if (failures.length > 0) throw new Error(failures.join('\n'));
    return { allowlist, catalog, normalization, receipt };
}

export async function recordBaseline(options: RecordBaselineOptions): Promise<string> {
    const inputs = await loadInputs(options);
    return publishBaseline(options.outputRoot, options.baselineId, async (temporaryDirectory) => {
        const artifactRelativePath = 'artifact';
        const artifact = await archiveArtifact(
            options.artifactPath,
            join(temporaryDirectory, artifactRelativePath),
        );
        await Promise.all([
            cp(options.catalogPath, join(temporaryDirectory, 'catalog.json')),
            cp(options.receiptPath, join(temporaryDirectory, 'receipt.json')),
            cp(options.normalizationPath, join(temporaryDirectory, 'normalization.json')),
            cp(options.allowlistPath, join(temporaryDirectory, 'allowlist.json')),
        ]);
        return {
            allowlistSha256: await sha256File(join(temporaryDirectory, 'allowlist.json')),
            artifact: { ...artifact, relativePath: artifactRelativePath },
            baselineId: options.baselineId,
            catalogSha256: await sha256File(join(temporaryDirectory, 'catalog.json')),
            createdAt: new Date().toISOString(),
            environment: inputs.receipt.environment,
            normalizationSha256: await sha256File(join(temporaryDirectory, 'normalization.json')),
            receiptSha256: await sha256File(join(temporaryDirectory, 'receipt.json')),
            scenarioIds: inputs.catalog.scenarios.map((scenario) => scenario.id),
            schemaVersion: 1,
            source: inputs.receipt.source,
            ...(options.startupExecutableRelativePath && {
                startupProbe: {
                    arguments: ['--version'],
                    executableRelativePath: join(
                        artifactRelativePath,
                        assertRelativePath(
                            options.startupExecutableRelativePath,
                            'Startup executable path',
                        ),
                    ),
                },
            }),
        } satisfies RefactorBaselineManifest;
    });
}

export async function verifyBaseline(baselineDirectory: string): Promise<VerifiedBaseline> {
    const manifest = refactorBaselineManifestSchema.parse(
        await readJson(join(baselineDirectory, 'manifest.json')),
    );
    assertRelativePath(manifest.artifact.relativePath, 'Baseline artifact path');
    const [catalogValue, receiptValue, normalizationValue, allowlistValue] = await Promise.all([
        readJson(join(baselineDirectory, 'catalog.json')),
        readJson(join(baselineDirectory, 'receipt.json')),
        readJson(join(baselineDirectory, 'normalization.json')),
        readJson(join(baselineDirectory, 'allowlist.json')),
    ]);
    const catalog = scenarioCatalogSchema.parse(catalogValue);
    const receipt = parityReceiptSchema.parse(receiptValue);
    const normalization = normalizationSchema.parse(normalizationValue);
    const allowlist = intentionalDifferenceSchema.parse(allowlistValue);
    const actualHashes = await Promise.all([
        sha256File(join(baselineDirectory, 'catalog.json')),
        sha256File(join(baselineDirectory, 'receipt.json')),
        sha256File(join(baselineDirectory, 'normalization.json')),
        sha256File(join(baselineDirectory, 'allowlist.json')),
    ]);
    const failures = [
        ...(actualHashes[0] === manifest.catalogSha256 ? [] : ['Catalog hash changed']),
        ...(actualHashes[1] === manifest.receiptSha256 ? [] : ['Receipt hash changed']),
        ...(actualHashes[2] === manifest.normalizationSha256 ? [] : ['Normalization hash changed']),
        ...(actualHashes[3] === manifest.allowlistSha256 ? [] : ['Allowlist hash changed']),
        ...coverageFailures(catalog, receipt),
        ...privacyViolations(receipt).map((path) => `Evidence contains prohibited ${path}`),
        ...(receipt.source.commit === manifest.source.commit &&
        receipt.source.tree === manifest.source.tree
            ? []
            : ['Baseline source identity changed']),
        ...(JSON.stringify(receipt.environment) === JSON.stringify(manifest.environment)
            ? []
            : ['Baseline environment identity changed']),
        ...(JSON.stringify(catalog.scenarios.map((scenario) => scenario.id)) ===
        JSON.stringify(manifest.scenarioIds)
            ? []
            : ['Baseline scenario identity changed']),
        ...(await verifyArtifactFiles(baselineDirectory, manifest)),
        ...(await verifyStartupProbe(baselineDirectory, manifest)),
    ];
    return { allowlist, catalog, failures, manifest, normalization, receipt };
}

export async function compareCandidate(
    baselineDirectory: string,
    candidateReceiptPath: string,
    outputPath?: string,
    currentBatch?: string,
): Promise<ParityComparisonSummary> {
    const baseline = await verifyBaseline(baselineDirectory);
    const candidate = parityReceiptSchema.parse(await readJson(candidateReceiptPath));
    const candidateDuplicateFailures = duplicateIds(candidate.scenarios.map(({ id }) => id)).map(
        (id) => `Duplicate candidate scenario: ${id}`,
    );
    const preflightFailures = [
        ...baseline.failures,
        ...candidateDuplicateFailures,
        ...(candidate.artifactRole === 'candidate'
            ? []
            : ['Candidate receipt artifactRole must be candidate']),
    ];
    const summary = compareReceipts(
        baseline.receipt,
        candidate,
        baseline.normalization,
        baseline.allowlist,
        currentBatch,
    );
    summary.failures.unshift(...preflightFailures);
    if (baseline.failures.length > 0) summary.status = 'blocked';
    else if (preflightFailures.length > 0) summary.status = 'invalid';
    if (outputPath) {
        await writeJsonAtomic(outputPath, summary, { ensureParent: true, mode: 0o600 });
    }
    return summary;
}
