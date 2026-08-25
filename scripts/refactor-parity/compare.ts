import { isDeepStrictEqual } from 'node:util';

import type {
    IntentionalDifferences,
    NormalizationRules,
    ParityComparisonSummary,
    ParityDifference,
    ParityReceipt,
    PerformanceMetric,
    ScenarioReceipt,
} from './contracts';

const prohibitedEvidenceKeys = new Set([
    'authorization',
    'apitoken',
    'credential',
    'draftbody',
    'environmentvalue',
    'environmentvalues',
    'password',
    'prompt',
    'responsebody',
    'secret',
    'sourcetext',
    'terminaloutput',
    'token',
    'transcript',
    'userprompt',
]);

const refactorBatchOrder = [
    'A0',
    'A1',
    'A2a',
    'A2b',
    'A2c',
    'A2d',
    'A2e',
    'A2f',
    'A3a',
    'A3b',
    'A4',
    'A5',
    'A6',
    'A7',
] as const;

function canonicalEvidenceKey(key: string): string {
    return key.replaceAll(/[^a-z\d]/giu, '').toLowerCase();
}

export function privacyViolations(value: unknown, currentPath = '$'): string[] {
    if (Array.isArray(value)) {
        return value.flatMap((entry, index) =>
            privacyViolations(entry, `${currentPath}[${index}]`),
        );
    }
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, entry]) => [
        ...(prohibitedEvidenceKeys.has(canonicalEvidenceKey(key)) ? [`${currentPath}.${key}`] : []),
        ...privacyViolations(entry, `${currentPath}.${key}`),
    ]);
}

function cloneJson<T>(value: T): T {
    return structuredClone(value);
}

function normalizedValue(
    kind: NormalizationRules['rules'][number]['kind'],
    value: unknown,
): unknown {
    if (kind === 'unordered-array') {
        if (!Array.isArray(value))
            throw new Error('unordered-array normalization requires an array');
        return value.toSorted((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)),
        );
    }
    return `<${kind}>`;
}

function normalizePath(
    value: unknown,
    segments: string[],
    kind: NormalizationRules['rules'][number]['kind'],
    index = 0,
): number {
    if (!value || typeof value !== 'object' || index >= segments.length) return 0;
    const segment = segments[index];
    if (segment === '*') {
        const record = value as Record<string, unknown>;
        let matches = 0;
        for (const key of Object.keys(record)) {
            if (index === segments.length - 1) {
                record[key] = normalizedValue(kind, record[key]);
                matches += 1;
            } else matches += normalizePath(record[key], segments, kind, index + 1);
        }
        return matches;
    }
    const record = value as Record<string, unknown>;
    if (!(segment in record)) return 0;
    if (index === segments.length - 1) {
        record[segment] = normalizedValue(kind, record[segment]);
        return 1;
    }
    // eslint-disable-next-line unicorn/no-useless-recursion -- JSON Pointer traversal follows nested evidence.
    return normalizePath(record[segment], segments, kind, index + 1);
}

export function normalizeReceipt(receipt: ParityReceipt, rules: NormalizationRules): ParityReceipt {
    const normalized = cloneJson(receipt);
    for (const rule of rules.rules) {
        const segments = rule.path
            .slice(1)
            .split('/')
            .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
        const evidenceBoundary = segments[3];
        if (
            segments[0] !== 'scenarios' ||
            !['*', ...receipt.scenarios.map((_scenario, index) => String(index))].includes(
                segments[1],
            ) ||
            segments[2] !== 'semantic' ||
            (evidenceBoundary !== 'artifactEvidence' && evidenceBoundary !== 'internalEvidence')
        ) {
            throw new Error(
                `Normalization may target only internal or artifact evidence: ${rule.path}`,
            );
        }
        const matches = normalizePath(normalized, segments, rule.kind);
        if (matches === 0 && normalized.scenarios.length > 0) {
            throw new Error(`Normalization path did not match evidence: ${rule.path}`);
        }
    }
    return normalized;
}

function collectDifferences(
    before: unknown,
    after: unknown,
    scenarioId: string,
    currentPath: string,
    output: ParityDifference[],
): void {
    if (isDeepStrictEqual(before, after)) return;
    if (Array.isArray(before) && Array.isArray(after)) {
        const length = Math.max(before.length, after.length);
        for (let index = 0; index < length; index += 1) {
            collectDifferences(
                before[index],
                after[index],
                scenarioId,
                `${currentPath}.${index}`,
                output,
            );
        }
        return;
    }
    if (
        before &&
        after &&
        typeof before === 'object' &&
        typeof after === 'object' &&
        !Array.isArray(before) &&
        !Array.isArray(after)
    ) {
        const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
        const sortedKeys = [...keys].toSorted((left, right) => left.localeCompare(right));
        for (const key of sortedKeys) {
            collectDifferences(
                (before as Record<string, unknown>)[key],
                (after as Record<string, unknown>)[key],
                scenarioId,
                `${currentPath}.${key}`,
                output,
            );
        }
        return;
    }
    output.push({ after, before, path: currentPath, scenarioId });
}

function metricStatistic(metric: PerformanceMetric): number {
    const sorted = metric.samples.toSorted((left, right) => left - right);
    if (metric.statistic === 'max') return sorted.at(-1)!;
    const percentile = metric.statistic === 'p50' ? 0.5 : 0.95;
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)];
}

function compareMetrics(before: ScenarioReceipt, after: ScenarioReceipt): string[] {
    const failures: string[] = [];
    const baselineMetrics = Object.entries(before.metrics ?? {});
    for (const [name, baselineMetric] of baselineMetrics) {
        const candidateMetric = after.metrics?.[name];
        if (!candidateMetric) {
            failures.push(`${before.id}: missing performance metric ${name}`);
            continue;
        }
        if (
            candidateMetric.statistic !== baselineMetric.statistic ||
            candidateMetric.unit !== baselineMetric.unit ||
            candidateMetric.samples.length !== baselineMetric.samples.length
        ) {
            failures.push(`${before.id}: performance metric ${name} changed contract`);
            continue;
        }
        const baseline = metricStatistic(baselineMetric);
        const candidate = metricStatistic(candidateMetric);
        const ratioCeiling = baseline * (1 + baselineMetric.maxRegressionRatio);
        if (candidate > ratioCeiling) {
            failures.push(`${before.id}: performance metric ${name} regressed beyond ratio budget`);
        }
        if (
            baselineMetric.absoluteCeiling !== undefined &&
            candidate > baselineMetric.absoluteCeiling
        ) {
            failures.push(`${before.id}: performance metric ${name} exceeded absolute ceiling`);
        }
    }
    const candidateMetricNames = Object.keys(after.metrics ?? {});
    for (const name of candidateMetricNames) {
        if (!(name in (before.metrics ?? {}))) {
            failures.push(`${before.id}: unknown candidate performance metric ${name}`);
        }
    }
    return failures;
}

export function compareReceipts(
    baseline: ParityReceipt,
    candidate: ParityReceipt,
    rules: NormalizationRules,
    allowlist: IntentionalDifferences,
    currentBatch?: string,
): ParityComparisonSummary {
    const failures = [
        ...privacyViolations(baseline).map(
            (path) => `Baseline evidence contains prohibited ${path}`,
        ),
        ...privacyViolations(candidate).map(
            (path) => `Candidate evidence contains prohibited ${path}`,
        ),
        ...privacyViolations(allowlist).map(
            (path) => `Intentional difference contains prohibited ${path}`,
        ),
    ];
    const currentBatchIndex = currentBatch ? refactorBatchOrder.indexOf(currentBatch as never) : -1;
    const disabledAllowlistIndexes = new Set<number>();
    if (!currentBatch && allowlist.entries.length > 0) {
        failures.push('A refactor batch is required when intentional differences exist');
    } else if (currentBatch && currentBatchIndex < 0) {
        failures.push(`Unknown refactor batch: ${currentBatch}`);
    }
    for (const [index, entry] of allowlist.entries.entries()) {
        const allowedPrefix =
            entry.visibility === 'artifact'
                ? 'semantic.artifactEvidence.'
                : 'semantic.internalEvidence.';
        if (!entry.path.startsWith(allowedPrefix)) {
            failures.push(
                `Intentional ${entry.visibility} difference targets product evidence: ${entry.path}`,
            );
            disabledAllowlistIndexes.add(index);
        }
        const expirationIndex = refactorBatchOrder.indexOf(entry.expiresAfterBatch as never);
        if (expirationIndex === -1) {
            failures.push(
                `Intentional difference has unknown expiration batch: ${entry.expiresAfterBatch}`,
            );
            disabledAllowlistIndexes.add(index);
        } else if (currentBatchIndex > expirationIndex) {
            failures.push(`Intentional difference expired after ${entry.expiresAfterBatch}`);
            disabledAllowlistIndexes.add(index);
        }
    }
    if (!isDeepStrictEqual(baseline.environment, candidate.environment)) {
        failures.push('Candidate environment does not match the frozen baseline environment');
    }
    const normalizedBefore = normalizeReceipt(baseline, rules);
    const normalizedAfter = normalizeReceipt(candidate, rules);
    const beforeById = new Map(
        normalizedBefore.scenarios.map((scenario) => [scenario.id, scenario]),
    );
    const afterById = new Map(normalizedAfter.scenarios.map((scenario) => [scenario.id, scenario]));
    const passedScenarios: string[] = [];
    const allowedDifferences: ParityDifference[] = [];
    const scenarios: ParityComparisonSummary['scenarios'] = [];
    const consumedAllowlist = new Set<number>();
    const baselineScenarios = [...beforeById];
    for (const [scenarioId, before] of baselineScenarios) {
        const after = afterById.get(scenarioId);
        if (!after) {
            const failure = `${scenarioId}: candidate receipt is missing`;
            failures.push(failure);
            scenarios.push({
                differences: [],
                failures: [failure],
                id: scenarioId,
                status: 'blocked',
            });
            continue;
        }
        if (before.status !== 'pass' || after.status !== 'pass') {
            const failure = `${scenarioId}: before and after must both be pass`;
            failures.push(failure);
            scenarios.push({
                differences: [],
                failures: [failure],
                id: scenarioId,
                status: after.status === 'blocked' ? 'blocked' : 'invalid',
            });
            continue;
        }
        const differences: ParityDifference[] = [];
        collectDifferences(before.semantic, after.semantic, scenarioId, 'semantic', differences);
        const unknown = differences.filter((difference) => {
            const entryIndex = allowlist.entries.findIndex(
                (entry, index) =>
                    !disabledAllowlistIndexes.has(index) &&
                    entry.scenarioId === difference.scenarioId &&
                    entry.path === difference.path &&
                    isDeepStrictEqual(entry.before, difference.before) &&
                    isDeepStrictEqual(entry.after, difference.after),
            );
            if (entryIndex === -1) return true;
            consumedAllowlist.add(entryIndex);
            allowedDifferences.push(difference);
            return false;
        });
        failures.push(...unknown.map((difference) => `${scenarioId}: changed ${difference.path}`));
        const metricFailures = compareMetrics(before, after);
        failures.push(...metricFailures);
        if (unknown.length === 0 && metricFailures.length === 0) {
            passedScenarios.push(scenarioId);
        }
        scenarios.push({
            differences,
            failures: [
                ...unknown.map((difference) => `${scenarioId}: changed ${difference.path}`),
                ...metricFailures,
            ],
            id: scenarioId,
            status: unknown.length === 0 && metricFailures.length === 0 ? 'pass' : 'fail',
        });
    }
    for (const scenarioId of afterById.keys()) {
        if (beforeById.has(scenarioId)) {
            continue;
        }

        const failure = `${scenarioId}: unknown candidate scenario`;
        failures.push(failure);
        scenarios.push({ differences: [], failures: [failure], id: scenarioId, status: 'invalid' });
    }
    for (const [index, entry] of allowlist.entries.entries()) {
        if (!consumedAllowlist.has(index)) {
            failures.push(`Unused intentional difference: ${entry.scenarioId}:${entry.path}`);
        }
    }
    const status = scenarios.some((scenario) => scenario.status === 'invalid')
        ? 'invalid'
        : scenarios.some((scenario) => scenario.status === 'blocked')
          ? 'blocked'
          : failures.length > 0
            ? 'fail'
            : 'pass';
    return {
        allowedDifferences,
        ...(candidate.artifactSha256 && {
            candidateArtifactSha256: candidate.artifactSha256,
        }),
        candidateCommit: candidate.source.commit,
        failures,
        passedScenarios,
        scenarios,
        schemaVersion: 1,
        status,
    };
}
