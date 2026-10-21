#!/usr/bin/env bun

/**
 * CI bundle budget gate: performs a timed production build and a timed macOS dir packaging pass, then fails when any
 * tracked artifact grows past its byte budget or either phase exceeds its wall-time budget. Budgets are absolute
 * ceilings with headroom above the optimized baseline recorded in docs/bundle-size.md: regressions that eat the
 * headroom must either be optimized away or consciously re-budgeted in the same PR that introduces them.
 */

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

import { execFileAsync } from './exec';

const MiB = 1_024 * 1_024;

interface SizeBudget {
    /**
     * Repository-relative path of the file or directory the budget covers.
     */
    path: string;
    maxBytes: number;
}

interface TimeBudget {
    label: string;
    maxSeconds: number;
    command: string[];
}

/**
 * Byte ceilings for the shipped bytes of the default debuggable build: every file except Source Maps (see
 * `ByteSelection`). Baseline (2026-10, measured with maps excluded): standalone Server ≈ 128.7 MiB, out/main ≈ 1.77
 * MiB, out/preload ≈ 18 KiB, out/renderer ≈ 39.0 MiB, app.asar ≈ 41.0 MiB, Caxri.app ≈ 415.2 MiB. The Server
 * deliberately includes its pinned Node runtime and bundled ripgrep binary so Desktop and platform deployments consume
 * one identical, self-contained artifact.
 *
 * Source Maps still ship in this flavor (≈ 88 MiB inside app.asar) so a canonical packaged build is debuggable without
 * a rebuild (docs/bundle-size.md, `.agents/skills/debug`). They are excluded here because the app never loads them:
 * when they counted, they were over half of every Desktop figure, and growth in debugging metadata ate the headroom
 * meant for real code. `SOURCE_MAP_REQUIRED` keeps the drop-is-suspicious check: an artifact that stops carrying maps
 * fails.
 *
 * The Renderer is minified without mangling (electron.vite.config.ts), which took it from ≈ 56.2 to ≈ 39.0 MiB; its
 * dominant costs are now Monaco and its language workers, Mermaid with ELK and Cytoscape, the PDF preview, and the full
 * vscode-icons SVG set, all of which are product decisions recorded in docs/bundle-size.md. Each ceiling keeps roughly
 * 10 to 20 percent headroom over the baseline.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-bundle-budget.test.ts
export const SIZE_BUDGETS: SizeBudget[] = [
    { path: 'apps/server/dist/server', maxBytes: 140 * MiB },
    { path: 'out/main', maxBytes: 2.5 * MiB },
    { path: 'out/preload', maxBytes: 64 * 1_024 },
    { path: 'out/renderer', maxBytes: 46 * MiB },
    {
        path: 'release.noindex/mac-arm64/Caxri.app/Contents/Resources/app.asar',
        maxBytes: 48 * MiB,
    },
    {
        path: 'release.noindex/mac-arm64/Caxri.app/Contents/Resources/server',
        maxBytes: 140 * MiB,
    },
    { path: 'release.noindex/mac-arm64/Caxri.app', maxBytes: 460 * MiB },
];

/**
 * Wall-time ceilings guard against toolchain regressions (for example accidentally enabling an analysis plugin on every
 * build) rather than machine noise, so they carry generous headroom over the historical runner baseline (build ≈ 25 s
 * with source maps, package ≈ 35 s).
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-bundle-budget.test.ts
export const TIME_BUDGETS: TimeBudget[] = [
    { label: 'build', maxSeconds: 180, command: ['bun', 'run', 'build'] },
    {
        label: 'package',
        maxSeconds: 300,
        command: ['./node_modules/.bin/electron-builder', '--mac', 'dir'],
    },
];

interface Measurement {
    label: string;
    actual: number;
    budget: number;
    unit: 'bytes' | 'seconds';
}

interface ComponentSpec {
    label: string;
    /**
     * Repository-relative directory whose file sizes are summed.
     */
    path: string;
    /**
     * When present, only files whose basename matches are counted (applied at every depth).
     */
    match?: RegExp;
}

/**
 * Reporting-only breakdown for the job summary: where the packaged bytes actually live. Budgeted artifacts stay in
 * SIZE_BUDGETS; these rows exist so a size regression is attributable at a glance (Electron runtime vs asar vs
 * renderer, and inside the renderer the two dominant product costs: Monaco language workers and bundled fonts).
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-bundle-budget.test.ts
export const REPORT_COMPONENTS: ComponentSpec[] = [
    { label: 'Caxri.app', path: 'release.noindex/mac-arm64/Caxri.app' },
    {
        label: 'Caxri.app › Frameworks (Electron runtime)',
        path: 'release.noindex/mac-arm64/Caxri.app/Contents/Frameworks',
    },
    {
        label: 'app.asar',
        path: 'release.noindex/mac-arm64/Caxri.app/Contents/Resources/app.asar',
    },
    {
        label: 'Embedded Server artifact',
        path: 'release.noindex/mac-arm64/Caxri.app/Contents/Resources/server',
    },
    { label: 'Server artifact', path: 'apps/server/dist/server' },
    { label: 'Server › pinned runtime', path: 'apps/server/dist/server/runtime' },
    {
        label: 'Server › ripgrep',
        path: 'apps/server/dist/server/runtime/bin',
        match: /^rg(?:\.exe)?$/u,
    },
    { label: 'Server › native dependencies', path: 'apps/server/dist/server/native' },
    { label: 'Server › bundles', path: 'apps/server/dist/server/bundles' },
    { label: 'out/main', path: 'out/main' },
    { label: 'out/preload', path: 'out/preload' },
    { label: 'out/renderer', path: 'out/renderer' },
    { label: 'out/renderer › monaco workers', path: 'out/renderer/assets', match: /worker/u },
    { label: 'out/renderer › fonts', path: 'out/renderer/assets', match: /\.(?:ttf|woff2?)$/u },
];

/**
 * Maps a report component to its byte budget when the same artifact is also gated.
 */
const COMPONENT_BUDGETS = new Map(
    REPORT_COMPONENTS.flatMap((component) => {
        const budget = SIZE_BUDGETS.find((sizeBudget) => sizeBudget.path === component.path);
        return budget && !component.match ? [[component.label, budget.maxBytes] as const] : [];
    }),
);

/**
 * Last green `main` measurements for repeated runs on the same machine. Local runs can reuse this user-level file;
 * disposable hosted runners normally report `n/a` because they do not inherit a prior cache. Missing baseline never
 * becomes a failure; absolute size budgets remain the portable gate.
 */
interface BundleBaseline {
    commit: string;
    recordedAt: string;
    seconds: Record<string, number>;
    sizes: Record<string, number>;
}

const BASELINE_PATH = join(homedir(), '.cache', 'caxri', 'bundle-baseline.json');

/**
 * Artifacts whose default flavor must still carry Source Maps. The byte budgets exclude maps, so this check is what
 * catches maps that silently stopped being emitted or packaged.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-bundle-budget.test.ts
export const SOURCE_MAP_REQUIRED = [
    'out/main',
    'out/renderer',
    'release.noindex/mac-arm64/Caxri.app/Contents/Resources/app.asar',
];

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-bundle-budget.test.ts
export function findMissingSourceMaps(sourceMapBytes: Record<string, number>): string[] {
    return SOURCE_MAP_REQUIRED.filter((path) => !(sourceMapBytes[path] > 0));
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-bundle-budget.test.ts
export function findBudgetViolations(measurements: Measurement[]): Measurement[] {
    return measurements.filter((measurement) => measurement.actual > measurement.budget);
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-bundle-budget.test.ts
export function formatMeasurement(measurement: Measurement): string {
    const format = (value: number): string =>
        measurement.unit === 'bytes' ? `${(value / MiB).toFixed(2)} MiB` : `${value.toFixed(1)} s`;
    const status = measurement.actual > measurement.budget ? 'OVER BUDGET' : 'ok';
    return `${measurement.label}: ${format(measurement.actual)} (budget ${format(measurement.budget)}) ${status}`;
}

const SOURCE_MAP = /\.map$/u;

/**
 * Which files a measurement counts. Budgets count `shipped` bytes: every file except Source Maps. The maps stay in the
 * default flavor for packaged debuggability (docs/bundle-size.md), but they are debugging metadata the app never loads,
 * so they must not crowd real code and assets out of a budget. `sourceMaps` counts only the maps so the summary still
 * reports them and the gate can fail when they disappear.
 */
type ByteSelection = 'all' | 'shipped' | 'sourceMaps';

function isSelected(selection: ByteSelection, name: string, match?: RegExp): boolean {
    if (match && !match.test(name)) return false;
    if (selection === 'shipped') return !SOURCE_MAP.test(name);
    if (selection === 'sourceMaps') return SOURCE_MAP.test(name);
    return true;
}

interface AsarEntry {
    files?: Record<string, AsarEntry>;
    size?: number;
    unpacked?: boolean;
}

/**
 * Sums the packed file sizes recorded in an asar header. The archive layout is a Chromium Pickle wrapping the header
 * length, then a Pickle wrapping the JSON header string, then the concatenated file contents; unpacked files live in
 * `app.asar.unpacked` and are not part of the archive bytes. https://github.com/electron/asar#format
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-bundle-budget.test.ts
export function sumAsarHeader(header: AsarEntry, selection: ByteSelection, match?: RegExp): number {
    let total = 0;
    const entries = Object.entries(header.files ?? {});
    for (const [name, entry] of entries) {
        if (entry.files) total += sumAsarHeader(entry, selection, match);
        else if (
            !entry.unpacked &&
            entry.size !== undefined &&
            isSelected(selection, name, match)
        ) {
            total += entry.size;
        }
    }
    return total;
}

async function readAsarHeader(archivePath: string): Promise<AsarEntry> {
    const handle = await open(archivePath, 'r');
    try {
        const prefix = Buffer.alloc(16);
        await handle.read(prefix, 0, 16, 0);
        const headerLength = prefix.readUInt32LE(12);
        const header = Buffer.alloc(headerLength);
        await handle.read(header, 0, headerLength, 16);
        return JSON.parse(header.toString('utf8')) as AsarEntry;
    } finally {
        await handle.close();
    }
}

/**
 * Logical byte size of a file or directory tree, optionally restricted to files whose basename matches. Uses file sizes
 * rather than disk blocks so the gate is deterministic across filesystems and block sizes. Recursion is manual because
 * macOS framework bundles contain `Versions/Current` directory symlinks that `readdir` with `recursive: true` would
 * traverse, double-counting the Electron framework; dirent type checks never follow symlinks, so each real file is
 * counted exactly once. An `.asar` archive is measured by its contents, so excluding Source Maps reaches inside it.
 */
async function measureBytes(
    targetPath: string,
    selection: ByteSelection,
    match?: RegExp,
): Promise<number> {
    const target = await stat(targetPath);
    if (!target.isDirectory()) {
        if (targetPath.endsWith('.asar')) {
            return selection === 'all'
                ? target.size
                : sumAsarHeader(await readAsarHeader(targetPath), selection, match);
        }
        return isSelected(selection, basename(targetPath), match) ? target.size : 0;
    }
    const entries = await readdir(targetPath, { withFileTypes: true });
    const sizes = await Promise.all(
        entries.map(async (entry) => {
            const entryPath = join(targetPath, entry.name);
            if (entry.isDirectory()) return measureBytes(entryPath, selection, match);
            if (!entry.isFile()) return 0;
            if (entry.name.endsWith('.asar')) return measureBytes(entryPath, selection, match);
            if (!isSelected(selection, entry.name, match)) return 0;
            const fileStat = await stat(entryPath);
            return fileStat.size;
        }),
    );
    let total = 0;
    for (const size of sizes) total += size;
    return total;
}

/**
 * Signed percentage change against the recorded baseline value; `n/a` when no baseline exists.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-bundle-budget.test.ts
export function formatDeltaPercent(current: number, baseline: number | undefined): string {
    if (baseline === undefined || baseline <= 0) return 'n/a';
    const percent = ((current - baseline) / baseline) * 100;
    return `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
}

interface SummaryInput {
    baseline?: BundleBaseline;
    commit: string;
    components: Array<{
        budgetBytes?: number;
        bytes: number;
        label: string;
        sourceMapBytes?: number;
    }>;
    times: Array<{ budgetSeconds: number; label: string; seconds: number }>;
}

/**
 * GitHub job-summary Markdown: phase timings and a component-level size breakdown, each with its budget (when the
 * artifact is gated) and the delta against the last green `main` build.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-bundle-budget.test.ts
export function buildSummaryMarkdown(input: SummaryInput): string {
    const formatMiB = (bytes: number): string => `${(bytes / MiB).toFixed(2)} MiB`;
    const lines = [
        `### Bundle budget: \`${input.commit.slice(0, 7)}\``,
        '',
        '| Phase | Time | Budget | Δ vs main |',
        '| --- | ---: | ---: | ---: |',
        ...input.times.map(
            (time) =>
                `| ${time.label} | ${time.seconds.toFixed(1)} s | ${time.budgetSeconds.toFixed(0)} s | ` +
                `${formatDeltaPercent(time.seconds, input.baseline?.seconds[time.label])} |`,
        ),
        '',
        '| Component | Size | Source Maps | Budget | Δ vs main |',
        '| --- | ---: | ---: | ---: | ---: |',
        ...input.components.map(
            (component) =>
                `| ${component.label} | ${formatMiB(component.bytes)} | ` +
                `${component.sourceMapBytes === undefined ? '—' : formatMiB(component.sourceMapBytes)} | ` +
                `${component.budgetBytes === undefined ? '—' : formatMiB(component.budgetBytes)} | ` +
                `${formatDeltaPercent(component.bytes, input.baseline?.sizes[component.label])} |`,
        ),
        '',
        'Size and Budget exclude Source Maps, which are reported separately.',
        '',
        input.baseline
            ? `Δ compares against the last green \`main\` build (\`${input.baseline.commit.slice(0, 7)}\`, recorded ${input.baseline.recordedAt}).`
            : '_No `main` baseline recorded yet; deltas will appear after the next green `main` build._',
        '',
    ];
    return lines.join('\n');
}

async function readBaseline(): Promise<BundleBaseline | undefined> {
    try {
        return JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as BundleBaseline;
    } catch {
        return undefined;
    }
}

async function writeBaseline(baseline: BundleBaseline): Promise<void> {
    await mkdir(dirname(BASELINE_PATH), { recursive: true });
    await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, undefined, 2)}\n`, 'utf8');
}

/**
 * Executable Server entry points inside the packaged standalone artifact. Loading them with the artifact's own runtime
 * proves every bundler-visible and external native import resolves without a sibling workspace. Each entry is expected
 * to fail fast on missing process wiring, not on module resolution.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-bundle-budget.test.ts
export const PACKAGED_SERVER_ENTRIES = [
    'bundles/server-core.js',
    'bundles/extension-host.js',
    'bundles/terminal-host.js',
];

const SOURCE_SERVER = 'apps/server/dist/server';
const PACKAGED_SERVER = 'release.noindex/mac-arm64/Caxri.app/Contents/Resources/server';

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-bundle-budget.test.ts
export function findModuleResolutionFailure(stderr: string): string | undefined {
    const match = /Cannot find (?:module|package) '[^']+'/u.exec(stderr);
    return match?.[0];
}

async function verifyPackagedModuleResolution(): Promise<string[]> {
    /**
     * The synthetic-merge checkout has no generated workspace output when this gate starts. Load the verifier only
     * after the timed build has emitted `@caxri/protocol`; a static import would fail before the build can run.
     */
    const { verifyServerArtifact } = await import('../apps/server/scripts/artifact');
    const failures: string[] = [];
    const packagedServer = resolve(PACKAGED_SERVER);
    const packagedManifest = await verifyServerArtifact(packagedServer);
    const sourceManifest = await verifyServerArtifact(resolve(SOURCE_SERVER));
    if (JSON.stringify(packagedManifest) !== JSON.stringify(sourceManifest)) {
        failures.push('packaged Server artifact differs from the source artifact manifest');
    }
    const executable = join(packagedServer, packagedManifest.runtime.executable);
    for (const entry of PACKAGED_SERVER_ENTRIES) {
        let stderr = '';
        try {
            // The entry is expected to exit non-zero on missing env wiring; only the stderr matters.
            // eslint-disable-next-line no-await-in-loop -- serial keeps the packaged binary contention-free
            await execFileAsync(executable, [join(packagedServer, entry)], { timeout: 30_000 });
        } catch (error) {
            stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : '';
        }
        const failure = findModuleResolutionFailure(stderr);
        if (failure) failures.push(`${entry}: ${failure}`);
    }
    return failures;
}

async function runTimed(budget: TimeBudget): Promise<number> {
    const startedAt = performance.now();
    const [command, ...arguments_] = budget.command;
    const child = spawn(command, arguments_, { stdio: 'inherit' });
    // `once` rejects when the child emits 'error' (e.g. missing binary) before exiting.
    const [exitCode] = (await once(child, 'exit')) as [number | null];
    if (exitCode !== 0) {
        throw new Error(`${budget.label} command failed with exit code ${exitCode}`);
    }
    return (performance.now() - startedAt) / 1_000;
}

async function main(): Promise<void> {
    // Stale packaging output would otherwise contaminate the size measurements below.
    await rm(resolve('release.noindex'), { recursive: true, force: true });

    const measurements: Measurement[] = [];
    for (const timeBudget of TIME_BUDGETS) {
        // Build must complete before packaging starts; the loop order encodes that dependency.
        // eslint-disable-next-line no-await-in-loop -- intentionally sequential phases
        const elapsedSeconds = await runTimed(timeBudget);
        measurements.push({
            label: `${timeBudget.label} time`,
            actual: elapsedSeconds,
            budget: timeBudget.maxSeconds,
            unit: 'seconds',
        });
    }

    const sizeMeasurements = await Promise.all(
        SIZE_BUDGETS.map(async (sizeBudget) => ({
            label: sizeBudget.path,
            actual: await measureBytes(resolve(sizeBudget.path), 'shipped'),
            budget: sizeBudget.maxBytes,
            unit: 'bytes' as const,
        })),
    );
    measurements.push(...sizeMeasurements);

    for (const measurement of measurements) {
        const receipt = {
            actual: Number(measurement.actual.toFixed(measurement.unit === 'bytes' ? 0 : 3)),
            budget: measurement.budget,
            label: measurement.label,
            unit: measurement.unit,
        };
        console.log(`CAXRI_BUNDLE_BUDGET ${JSON.stringify(receipt)}`);
        console.log(formatMeasurement(measurement));
    }

    const components = await Promise.all(
        REPORT_COMPONENTS.map(async (component) => ({
            budgetBytes: COMPONENT_BUDGETS.get(component.label),
            bytes: await measureBytes(resolve(component.path), 'shipped', component.match),
            label: component.label,
            sourceMapBytes: await measureBytes(
                resolve(component.path),
                'sourceMaps',
                component.match,
            ),
        })),
    );
    const times = measurements
        .filter((measurement) => measurement.unit === 'seconds')
        .map((measurement) => ({
            budgetSeconds: measurement.budget,
            label: measurement.label.replace(/ time$/u, ''),
            seconds: measurement.actual,
        }));
    const commit = process.env.GITHUB_SHA ?? 'local';
    const baseline = await readBaseline();
    // Written before the gate verdicts below so failing runs still publish their breakdown.
    if (process.env.GITHUB_STEP_SUMMARY) {
        await appendFile(
            process.env.GITHUB_STEP_SUMMARY,
            buildSummaryMarkdown({ baseline, commit, components, times }),
            'utf8',
        );
    }

    const resolutionFailures = await verifyPackagedModuleResolution();
    if (resolutionFailures.length > 0) {
        console.error('\nPackaged module resolution failed:');
        for (const failure of resolutionFailures) console.error(`  - ${failure}`);
        console.error(
            '\nA runtime dependency is missing from the package. Either bundle it (keep it in ' +
                'devDependencies with a bundler-visible import) or ship it in production dependencies.',
        );
        process.exit(1);
    }
    console.log('Packaged Server artifact integrity and module resolution ok.');

    const sourceMapEntries = await Promise.all(
        SOURCE_MAP_REQUIRED.map(
            async (path) => [path, await measureBytes(resolve(path), 'sourceMaps')] as const,
        ),
    );
    const missingSourceMaps = findMissingSourceMaps(Object.fromEntries(sourceMapEntries));
    if (missingSourceMaps.length > 0) {
        console.error('\nSource Maps are missing from the default debuggable build:');
        for (const path of missingSourceMaps) console.error(`  - ${path}`);
        console.error(
            '\nThe size budgets exclude maps, so a lost map would otherwise pass unnoticed.',
        );
        process.exit(1);
    }

    const violations = findBudgetViolations(measurements);
    if (violations.length > 0) {
        console.error(`\nBundle budget gate failed (${violations.length} violation(s)):`);
        for (const violation of violations) console.error(`  - ${formatMeasurement(violation)}`);
        console.error(
            '\nEither optimize the regression away or consciously raise the budget in ' +
                'scripts/ci-bundle-budget.ts and docs/bundle-size.md within the same PR.',
        );
        process.exit(1);
    }
    console.log('\nBundle budget gate passed.');

    // Only a fully green run on `main` may become the comparison baseline for future runs.
    if (process.env.GITHUB_REF === 'refs/heads/main') {
        await writeBaseline({
            commit,
            recordedAt: new Date().toISOString(),
            seconds: Object.fromEntries(times.map((time) => [time.label, time.seconds])),
            sizes: Object.fromEntries(
                components.map((component) => [component.label, component.bytes]),
            ),
        });
        console.log(`Baseline refreshed at ${BASELINE_PATH}.`);
    }
}

if (import.meta.main) {
    await main();
}
