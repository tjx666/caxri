#!/usr/bin/env bun

/**
 * Measures build output sizes for the pull-request size report (docs/bundle-size.md#pull-request-size-report). CI
 * writes one JSON report per kind; `scripts/ci-size-comment.ts` compares a pull request's reports with the nearest
 * `main` baseline and posts the result as a sticky comment.
 *
 * Kinds:
 *
 * - `desktop`: the platform-neutral build output (`bun run build`), so a Linux runner measures the same bytes a Mac
 *   would.
 * - `packaged`: the macOS `.app` the bundle budget job packages; only full-scope runs produce it.
 * - `mobile`: an `expo export --platform android` directory: the Hermes bytecode the APK embeds plus its assets.
 *
 * Usage: `bun run scripts/ci-size-report.ts --kind desktop --sha <head> --out size-report.json [--root <dir>]`
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import type { ComponentSpec } from './ci-bundle-budget';
import { measureBytes, REPORT_COMPONENTS, SIZE_BUDGETS } from './ci-bundle-budget';

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/ci-size-comment.ts and its tests
export const SIZE_REPORT_KINDS = ['desktop', 'packaged', 'mobile'] as const;

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/ci-size-comment.ts and its tests
export type SizeReportKind = (typeof SIZE_REPORT_KINDS)[number];

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/ci-size-comment.ts and its tests
export interface SizeReportComponent extends ComponentSpec {
    /**
     * The bundle budget ceiling for the same path, shown beside the size.
     */
    budgetBytes?: number;
}

const reportComponents = (labels: readonly string[]): SizeReportComponent[] =>
    labels.map((label) => {
        const component = REPORT_COMPONENTS.find((candidate) => candidate.label === label);
        if (!component) throw new Error(`Unknown bundle report component: ${label}`);
        const budget = component.match
            ? undefined
            : SIZE_BUDGETS.find((sizeBudget) => sizeBudget.path === component.path);
        return { ...component, budgetBytes: budget?.maxBytes };
    });

/**
 * The rows of each report kind. Labels are the comparison keys between a pull request and its `main` baseline and the
 * only text from a report that reaches the comment, so renaming one drops its delta until `main` records the new label.
 * Desktop rows reuse the bundle budget's labels so the job summary and the comment name the same things. Mobile paths
 * are relative to the `expo export` output directory.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/ci-size-comment.ts and its tests
export const SIZE_REPORT_COMPONENTS: Record<SizeReportKind, SizeReportComponent[]> = {
    desktop: reportComponents([
        'out/main',
        'out/preload',
        'out/renderer',
        'out/renderer › monaco workers',
        'out/renderer › fonts',
        'Server › bundles',
    ]),
    packaged: reportComponents([
        'Caxri.app',
        'Caxri.app › Frameworks (Electron runtime)',
        'app.asar',
        'Embedded Server artifact',
    ]),
    mobile: [
        { label: 'Android JS bundle (Hermes bytecode)', path: '_expo/static/js/android' },
        { label: 'Bundled assets', path: 'assets' },
    ],
};

interface ComponentSize {
    /**
     * Bytes excluding Source Maps, the figure the bundle budget gates.
     */
    bytes: number;
    sourceMapBytes: number;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/ci-size-comment.ts and its tests
export interface SizeReport {
    schema: 1;
    kind: SizeReportKind;
    sha: string;
    components: Partial<Record<string, ComponentSize>>;
}

/**
 * Reports come from pull request runs, including forks, so the comment job treats them as untrusted input.
 */
const MAX_REPORT_BYTES = 64 * 1_024;
const MAX_COMPONENT_BYTES = 2 ** 40;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isByteCount = (value: unknown): value is number =>
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_COMPONENT_BYTES;

/**
 * Parses an untrusted report. Only allowlisted labels survive, so no text from the artifact can reach the comment
 * Markdown; an unknown label (for example from an older `main` before a rename) is dropped rather than rejected.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/ci-size-comment.ts and its tests
export function parseSizeReport(text: string, kind: SizeReportKind): SizeReport {
    if (text.length > MAX_REPORT_BYTES) throw new Error('Size report exceeds 64 KiB');
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || value.schema !== 1) throw new Error('Unsupported size report schema');
    if (value.kind !== kind) throw new Error(`Expected a ${kind} size report`);
    if (typeof value.sha !== 'string' || !/^[0-9a-f]{40}$/u.test(value.sha))
        throw new Error('Size report has no commit SHA');
    if (!isRecord(value.components)) throw new Error('Size report has no components');
    const components: Record<string, ComponentSize> = {};
    const specs = SIZE_REPORT_COMPONENTS[kind];
    for (const { label } of specs) {
        const entry = value.components[label];
        if (entry === undefined) continue;
        if (!isRecord(entry) || !isByteCount(entry.bytes) || !isByteCount(entry.sourceMapBytes))
            throw new Error(`Size report component ${label} is not a byte count`);
        components[label] = { bytes: entry.bytes, sourceMapBytes: entry.sourceMapBytes };
    }
    return { schema: 1, kind, sha: value.sha, components };
}

/**
 * Measures every component of `kind` under `root`. A component whose path is missing fails the measurement: a build
 * that stops emitting a tracked output should be loud, not silently reported as zero.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-size-report.test.ts
export async function measureSizeReport(
    kind: SizeReportKind,
    root: string,
    sha: string,
): Promise<SizeReport> {
    const entries = await Promise.all(
        SIZE_REPORT_COMPONENTS[kind].map(async ({ label, match, path }) => {
            const target = resolve(root, path);
            const [bytes, sourceMapBytes] = await Promise.all([
                measureBytes(target, 'shipped', match),
                measureBytes(target, 'sourceMaps', match),
            ]);
            return [label, { bytes, sourceMapBytes }] as const;
        }),
    );
    return { schema: 1, kind, sha, components: Object.fromEntries(entries) };
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            kind: { type: 'string' },
            out: { type: 'string' },
            root: { type: 'string', default: '.' },
            sha: { type: 'string' },
        },
    });
    const kind = SIZE_REPORT_KINDS.find((candidate) => candidate === values.kind);
    if (!kind) throw new Error(`--kind must be one of ${SIZE_REPORT_KINDS.join(', ')}`);
    if (!values.out) throw new Error('--out is required');
    if (!values.sha || !/^[0-9a-f]{40}$/u.test(values.sha))
        throw new Error('--sha must be a full commit SHA');
    const report = await measureSizeReport(kind, values.root, values.sha);
    await mkdir(dirname(resolve(values.out)), { recursive: true });
    await writeFile(values.out, `${JSON.stringify(report, undefined, 2)}\n`, 'utf8');
    console.log(`CAXRI_SIZE_REPORT ${JSON.stringify(report)}`);
}

if (import.meta.main) {
    await main();
}
