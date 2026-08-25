import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
import {
    archiveArtifact,
    hashArtifact,
    publishBaseline,
    readJson,
    sha256File,
    verifyArtifactFiles,
} from './io';

export interface RecordBaselineOptions {
    allowlistPath: string;
    artifactPath: string;
    baselineId: string;
    catalogPath: string;
    normalizationPath: string;
    outputRoot: string;
    receiptPath: string;
    sourceMarkerRelativePath: string;
    startupExecutableRelativePath: string;
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
    const executable = join(
        baselineDirectory,
        assertRelativePath(manifest.artifact.relativePath, 'Baseline artifact path'),
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

async function verifySourceMarker(
    artifactPath: string,
    markerRelativePath: string,
    commit: string,
): Promise<string[]> {
    const markerPath = join(
        artifactPath,
        assertRelativePath(markerRelativePath, 'Artifact source marker path'),
    );
    try {
        const marker = await readFile(markerPath);
        return marker.includes(Buffer.from(commit.slice(0, 8), 'utf8'))
            ? []
            : ['Artifact source marker does not match the receipt commit'];
    } catch (error: unknown) {
        return [
            `Artifact source marker could not be read: ${error instanceof Error ? error.message : String(error)}`,
        ];
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
    const receiptById = new Map(receipt.scenarios.map((scenario) => [scenario.id, scenario]));
    const requiredMetricFailures = catalog.scenarios.flatMap((scenario) => {
        const receiptScenario = receiptById.get(scenario.id);
        if (!receiptScenario) return [];
        const requiredMetrics = scenario.requiredMetrics ?? [];
        return [
            ...duplicateIds(requiredMetrics).map(
                (name) => `Duplicate required metric for ${scenario.id}: ${name}`,
            ),
            ...requiredMetrics
                .filter((name) => !receiptScenario.metrics?.[name])
                .map((name) => `Missing required metric for ${scenario.id}: ${name}`),
        ];
    });
    return [
        ...duplicateIds(catalogIds).map((id) => `Duplicate catalog scenario: ${id}`),
        ...duplicateIds(receiptIds).map((id) => `Duplicate receipt scenario: ${id}`),
        ...catalogIds.filter((id) => !receiptSet.has(id)).map((id) => `Missing receipt: ${id}`),
        ...receiptIds.filter((id) => !catalogSet.has(id)).map((id) => `Unknown receipt: ${id}`),
        ...requiredMetricFailures,
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
    if (!options.startupExecutableRelativePath) {
        throw new Error('Startup executable path is required');
    }
    if (!options.sourceMarkerRelativePath) {
        throw new Error('Artifact source marker path is required');
    }
    assertRelativePath(options.startupExecutableRelativePath, 'Startup executable path');
    assertRelativePath(options.sourceMarkerRelativePath, 'Artifact source marker path');
    const inputs = await loadInputs(options);
    const markerFailures = await verifySourceMarker(
        options.artifactPath,
        options.sourceMarkerRelativePath,
        inputs.receipt.source.commit,
    );
    if (markerFailures.length > 0) throw new Error(markerFailures.join('\n'));
    return publishBaseline(options.outputRoot, options.baselineId, async (temporaryDirectory) => {
        const artifactRelativePath = 'artifact';
        const artifact = await archiveArtifact(
            options.artifactPath,
            join(temporaryDirectory, artifactRelativePath),
        );
        await Promise.all([
            writeJsonAtomic(join(temporaryDirectory, 'catalog.json'), inputs.catalog, {
                mode: 0o600,
            }),
            writeJsonAtomic(join(temporaryDirectory, 'receipt.json'), inputs.receipt, {
                mode: 0o600,
            }),
            writeJsonAtomic(join(temporaryDirectory, 'normalization.json'), inputs.normalization, {
                mode: 0o600,
            }),
            writeJsonAtomic(join(temporaryDirectory, 'allowlist.json'), inputs.allowlist, {
                mode: 0o600,
            }),
        ]);
        return {
            allowlistSha256: await sha256File(join(temporaryDirectory, 'allowlist.json')),
            artifact: {
                ...artifact,
                relativePath: artifactRelativePath,
                sourceMarkerRelativePath: options.sourceMarkerRelativePath,
            },
            baselineId: options.baselineId,
            catalogSha256: await sha256File(join(temporaryDirectory, 'catalog.json')),
            createdAt: new Date().toISOString(),
            environment: inputs.receipt.environment,
            normalizationSha256: await sha256File(join(temporaryDirectory, 'normalization.json')),
            receiptSha256: await sha256File(join(temporaryDirectory, 'receipt.json')),
            scenarioIds: inputs.catalog.scenarios.map((scenario) => scenario.id),
            schemaVersion: 1,
            source: inputs.receipt.source,
            startupProbe: {
                arguments: ['--version'],
                executableRelativePath: assertRelativePath(
                    options.startupExecutableRelativePath,
                    'Startup executable path',
                ),
            },
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
        ...(await verifySourceMarker(
            join(baselineDirectory, manifest.artifact.relativePath),
            manifest.artifact.sourceMarkerRelativePath,
            manifest.source.commit,
        )),
        ...(await verifyStartupProbe(baselineDirectory, manifest)),
    ];
    return { allowlist, catalog, failures, manifest, normalization, receipt };
}

export async function compareCandidate(
    baselineDirectory: string,
    candidateReceiptPath: string,
    candidateArtifactPath: string,
    candidateSourceMarkerRelativePath: string,
    outputPath?: string,
    currentBatch?: string,
    repoPath = process.cwd(),
): Promise<ParityComparisonSummary> {
    const baseline = await verifyBaseline(baselineDirectory);
    const candidate = parityReceiptSchema.parse(await readJson(candidateReceiptPath));
    let candidateArtifactSha256: string | undefined;
    const candidateIdentityFailures: string[] = [];
    try {
        candidateArtifactSha256 = (await hashArtifact(candidateArtifactPath)).aggregateSha256;
        if (candidate.artifactSha256 !== candidateArtifactSha256) {
            candidateIdentityFailures.push(
                'Candidate receipt is not bound to the supplied artifact hash',
            );
        }
        candidateIdentityFailures.push(
            ...(await verifySourceMarker(
                candidateArtifactPath,
                candidateSourceMarkerRelativePath,
                candidate.source.commit,
            )),
        );
    } catch (error: unknown) {
        candidateIdentityFailures.push(
            `Candidate artifact could not be hashed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    try {
        const [{ stdout: commitOutput }, { stdout: treeOutput }, { stdout: statusOutput }] =
            await Promise.all([
                execFileAsync('git', ['rev-parse', 'HEAD'], {
                    cwd: repoPath,
                    encoding: 'utf8',
                }),
                execFileAsync('git', ['rev-parse', 'HEAD^{tree}'], {
                    cwd: repoPath,
                    encoding: 'utf8',
                }),
                execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
                    cwd: repoPath,
                    encoding: 'utf8',
                }),
            ]);
        if (statusOutput.trim().length > 0) {
            candidateIdentityFailures.push('Candidate repository has uncommitted source changes');
        }
        if (candidate.source.commit !== commitOutput.trim()) {
            candidateIdentityFailures.push('Candidate receipt commit does not match Git HEAD');
        }
        if (candidate.source.tree !== treeOutput.trim()) {
            candidateIdentityFailures.push('Candidate receipt tree does not match Git HEAD');
        }
    } catch (error: unknown) {
        candidateIdentityFailures.push(
            `Candidate Git identity could not be verified: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    const candidateDuplicateFailures = duplicateIds(candidate.scenarios.map(({ id }) => id)).map(
        (id) => `Duplicate candidate scenario: ${id}`,
    );
    const preflightFailures = [
        ...baseline.failures,
        ...candidateIdentityFailures,
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
    summary.candidateArtifactSha256 = candidateArtifactSha256;
    summary.failures.unshift(...preflightFailures);
    if (baseline.failures.length > 0) summary.status = 'blocked';
    else if (preflightFailures.length > 0) summary.status = 'invalid';
    if (outputPath) {
        await writeJsonAtomic(outputPath, summary, { ensureParent: true, mode: 0o600 });
    }
    return summary;
}
