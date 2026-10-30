#!/usr/bin/env bun

import { resolve } from 'node:path';
import process from 'node:process';

import { isDocumentationPath, isRepoSkillPath } from './ci-execution-plan';
import {
    isFullValidationPath,
    isProtectedRetryPath,
    ordinaryE2ESpecPattern,
} from './ci-path-policy';
import { execFileAsync } from './exec';

/**
 * Diff-driven surface/proof matrix. Agents changing one Caxri product surface routinely forget a sibling surface the
 * same diff also touches (Desktop preload without Renderer, a protocol contract without one of its four clients, ...).
 * This CLI reports every product surface a diff reaches and the proof the repository already requires for that surface,
 * so an agent, or the `pull-request` skill, can check the matrix instead of re-deriving it from memory each time.
 *
 * Classification reuses the path predicates `ci-execution-plan.ts` and `ci-path-policy.ts` maintain for CI scope
 * decisions instead of inventing a second, driftable classifier: the same `docs/`, `.agents/skills/`, and
 * CI-protected/full-validation path rules apply here.
 */

type ProductSurface =
    | 'ci'
    | 'cli'
    | 'contributor-skills'
    | 'desktop-main'
    | 'desktop-preload'
    | 'desktop-renderer'
    | 'docs'
    | 'e2e'
    | 'extension-host'
    | 'extensions'
    | 'mobile'
    | 'protocol'
    | 'server'
    | 'terminal-host';

interface SurfaceDefinition {
    id: ProductSurface;
    label: string;
    isMatch: (path: string) => boolean;
    proof: string;
}

const DESKTOP_ROOT = 'apps/desktop/';
const DESKTOP_MAIN_ROOT = 'apps/desktop/src/main/';
const DESKTOP_PRELOAD_ROOT = 'apps/desktop/src/preload/';
const DESKTOP_RENDERER_ROOT = 'apps/desktop/src/renderer/';
const DESKTOP_SHARED_ROOT = 'apps/desktop/src/shared/';

const SERVER_ROOT = 'apps/server/';
const TERMINAL_HOST_ROOT = 'apps/server/src/terminal-host/';
const EXTENSION_HOST_ROOT = 'apps/server/src/extension-host/';

const CLI_ROOT = 'apps/cli/';
/**
 * `@caxri/client` is the Server connection library imported by Desktop Main, Desktop Preload, and the CLI (confirmed
 * against the current tree), so a change there needs each consumer's proof.
 */
const CLIENT_ROOT = 'packages/client/';
const MOBILE_ROOT = 'apps/mobile/';
const PROTOCOL_ROOT = 'packages/protocol/';
const EXTENSIONS_ROOT = 'extensions/';
const E2E_ROOT = 'e2e/';

/**
 * The `apps/desktop/src/shared/` directory is imported from Main, Preload, and Renderer alike (confirmed against the
 * current tree), so it deliberately tags all three Desktop surfaces instead of guessing one owner. Matrix rows are
 * additive, not exclusive: a file may need more than one proof.
 */
function isDesktopMainPath(path: string): boolean {
    if (
        path.startsWith(DESKTOP_MAIN_ROOT) ||
        path.startsWith(DESKTOP_SHARED_ROOT) ||
        path.startsWith(CLIENT_ROOT)
    )
        return true;
    return (
        path.startsWith(DESKTOP_ROOT) &&
        !path.startsWith(DESKTOP_PRELOAD_ROOT) &&
        !path.startsWith(DESKTOP_RENDERER_ROOT) &&
        !path.startsWith(DESKTOP_SHARED_ROOT)
    );
}

function isServerPath(path: string): boolean {
    return (
        path.startsWith(SERVER_ROOT) &&
        !path.startsWith(TERMINAL_HOST_ROOT) &&
        !path.startsWith(EXTENSION_HOST_ROOT)
    );
}

const surfaceDefinitions: readonly SurfaceDefinition[] = [
    {
        id: 'desktop-main',
        label: 'Desktop main',
        isMatch: isDesktopMainPath,
        proof: 'When this changes window, dialog, menu, lease, or root-grant behavior, exercise it through a live dev instance (`switch-worktree` dev) or a targeted Playwright Electron spec; native macOS dialogs stay stubbed unless this request explicitly asks to verify that dialog. See the `debug` skill.',
    },
    {
        id: 'desktop-preload',
        label: 'Desktop preload',
        isMatch: (path) =>
            path.startsWith(DESKTOP_PRELOAD_ROOT) ||
            path.startsWith(DESKTOP_SHARED_ROOT) ||
            path.startsWith(CLIENT_ROOT),
        proof: 'Confirm the typed IPC channel is consumed correctly by both its Main-process handler and its Renderer caller, and that it never bypasses the structured IPC contract with an untrusted shell string. Exercise the changed channel end-to-end over CDP or a Playwright Electron spec. See the `debug` skill.',
    },
    {
        id: 'desktop-renderer',
        label: 'Desktop Renderer',
        isMatch: (path) =>
            path.startsWith(DESKTOP_RENDERER_ROOT) || path.startsWith(DESKTOP_SHARED_ROOT),
        proof: 'A user-visible Renderer change is not done until it has been verified visually in the running dev app over CDP; passing unit or e2e gates alone does not count. See the `debug` skill.',
    },
    {
        id: 'server',
        label: 'Server',
        isMatch: isServerPath,
        proof: 'Before using a live instance to verify or disprove this Server change, confirm the Server Core and Extension Host process start times postdate the change. See the `debug` skill.',
    },
    {
        id: 'terminal-host',
        label: 'Terminal Host',
        isMatch: (path) => path.startsWith(TERMINAL_HOST_ROOT),
        proof: 'Terminal Host owns PTYs: exercise the affected spawn, input, resize, suspend, or exit path through a live Session/Terminal or a targeted regression. See the `debug` skill.',
    },
    {
        id: 'extension-host',
        label: 'Extension Host',
        isMatch: (path) => path.startsWith(EXTENSION_HOST_ROOT),
        proof: 'Extension Host owns native ESM extensions: exercise the affected module-loader, API-factory, or workspace-bridge path through its Vitest regression or a live extension load. See the `debug` skill.',
    },
    {
        id: 'cli',
        label: 'CLI',
        isMatch: (path) => path.startsWith(CLI_ROOT) || path.startsWith(CLIENT_ROOT),
        proof: 'Verify the exact `caxri` command output or behavior on the real CLI surface, not just a setup script used to reach another surface. See the `acceptance` skill (cli surface).',
    },
    {
        id: 'mobile',
        label: 'Mobile',
        isMatch: (path) => path.startsWith(MOBILE_ROOT),
        proof: 'A user-visible mobile change is not done until its screens were captured on the disposable emulator and read as a first-time user would: check labels and terminology against Desktop, duplicate entries against the same data, and the offline, empty, and error states. See the `acceptance` skill (Android surface).',
    },
    {
        id: 'protocol',
        label: 'Protocol contracts',
        isMatch: (path) => path.startsWith(PROTOCOL_ROOT),
        proof: 'Confirm all four clients that import `@caxri/protocol` (Desktop, Server, CLI, Mobile) still compile against and correctly consume the changed contract.',
    },
    {
        id: 'extensions',
        label: 'Extensions',
        isMatch: (path) => path.startsWith(EXTENSIONS_ROOT),
        proof: 'Verify the packaged native ESM extension still loads and behaves through its bundle or packaging contract test, or a live Extension Host load.',
    },
    {
        id: 'e2e',
        label: 'e2e',
        isMatch: (path) => path.startsWith(E2E_ROOT) || ordinaryE2ESpecPattern.test(path),
        proof: 'Run the changed or added Playwright Electron spec directly: confirm it fails against the reverted behavior and passes against the fix. See the `e2e-testing` skill.',
    },
    {
        id: 'docs',
        label: 'Docs',
        isMatch: (path) => isDocumentationPath(path),
        proof: 'Run the repository docs-check gate over the changed Markdown (frontmatter, cross-references, repository-path links, index completeness) before merging.',
    },
    {
        id: 'contributor-skills',
        label: 'Contributor skills',
        isMatch: (path) => isRepoSkillPath(path),
        proof: 'Run `bunx vitest run scripts/__tests__/skill-invocation.test.ts` and confirm frontmatter, cross-skill references, and the `.claude/skills` symlink still hold.',
    },
    {
        id: 'ci',
        label: 'CI',
        isMatch: (path) =>
            isProtectedRetryPath(path) || isFullValidationPath(path) || path.startsWith('.github/'),
        proof: 'This changes CI-protected or full-validation-triggering configuration: watch a real run for the affected workflow path with `bun run scripts/watch-ci.ts --run <id>` before merging instead of relying on a local guess about scope.',
    },
];

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/surface-matrix.test.ts
export interface SurfaceMatrixInput {
    changedFiles: readonly string[];
    /**
     * Unified `git diff` text, used only for the best-effort reverse-state heuristic below. Omitted when the caller
     * supplied an explicit file list instead of letting this CLI read Git.
     */
    diffText?: string;
}

interface SurfaceMatrixEntry {
    files: string[];
    label: string;
    proof: string;
    surface: ProductSurface;
}

interface ReverseStateEvaluation {
    /**
     * Forward/reverse action-verb pairs whose forward verb appeared added without its reverse.
     */
    gaps: string[];
    /**
     * False when no diff text was available to scan (explicit `--files` run).
     */
    evaluated: boolean;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/surface-matrix.test.ts
export interface SurfaceMatrixResult {
    entries: SurfaceMatrixEntry[];
    reverseState: ReverseStateEvaluation;
    unclassifiedFiles: string[];
}

/**
 * Curated one-way user actions worth a reminder: Caxri's product invariants call out exactly this shape of bug ("a
 * one-way door is a bug: create needs delete, enable needs disable"). This list is intentionally small and advisory:
 * see `detectReverseStateGaps` for why it never fails the run.
 */
const REVERSIBLE_ACTION_PAIRS: ReadonlyArray<readonly [forward: string, reverse: string]> = [
    ['create', 'delete'],
    ['add', 'remove'],
    ['enable', 'disable'],
    ['start', 'stop'],
    ['open', 'close'],
    ['connect', 'disconnect'],
    ['grant', 'revoke'],
    ['subscribe', 'unsubscribe'],
    ['register', 'unregister'],
    ['mount', 'unmount'],
    ['show', 'hide'],
    ['expand', 'collapse'],
    ['pin', 'unpin'],
    ['lock', 'unlock'],
    ['suspend', 'resume'],
];

function extractAddedLines(diffText: string): string {
    return diffText
        .split('\n')
        .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
        .join('\n')
        .toLowerCase();
}

/**
 * Word-stem, not whole-word, matching: it must catch "created"/"creates"/"creating" as well as "create". That trades
 * precision for recall on purpose: the caller only ever surfaces this as a question to confirm, never as a failing
 * check, so a false positive costs one glance and a false negative costs a silently shipped one-way door.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/surface-matrix.test.ts
export function detectReverseStateGaps(diffText: string): string[] {
    const added = extractAddedLines(diffText);
    const gaps: string[] = [];
    for (const [forward, reverse] of REVERSIBLE_ACTION_PAIRS) {
        const forwardPattern = new RegExp(String.raw`\b${forward}\w*`, 'u');
        const reversePattern = new RegExp(String.raw`\b${reverse}\w*`, 'u');
        if (forwardPattern.test(added) && !reversePattern.test(added))
            gaps.push(`${forward}/${reverse}`);
    }
    return gaps;
}

function evaluateReverseState(diffText: string | undefined): ReverseStateEvaluation {
    if (diffText === undefined) return { evaluated: false, gaps: [] };
    return { evaluated: true, gaps: detectReverseStateGaps(diffText) };
}

/**
 * Pure classification: every entry a caller can reach through `--json` or the Markdown table comes from this function,
 * so fixture tests exercise the real matrix instead of a rendering-only stub.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/surface-matrix.test.ts
export function buildSurfaceMatrix(input: SurfaceMatrixInput): SurfaceMatrixResult {
    const changedFiles = [...new Set(input.changedFiles)].toSorted((left, right) =>
        left.localeCompare(right),
    );
    const entries: SurfaceMatrixEntry[] = [];
    for (const definition of surfaceDefinitions) {
        const files = changedFiles.filter((file) => definition.isMatch(file));
        if (files.length === 0) continue;
        entries.push({
            files,
            label: definition.label,
            proof: definition.proof,
            surface: definition.id,
        });
    }
    const unclassifiedFiles = changedFiles.filter((file) =>
        surfaceDefinitions.every((definition) => !definition.isMatch(file)),
    );
    return { entries, reverseState: evaluateReverseState(input.diffText), unclassifiedFiles };
}

const MAX_LISTED_FILES = 6;

function formatFileList(files: readonly string[]): string {
    const shown = files
        .slice(0, MAX_LISTED_FILES)
        .map((file) => `\`${file}\``)
        .join(', ');
    const remaining = files.length - MAX_LISTED_FILES;
    return remaining > 0 ? `${shown}, +${remaining} more` : shown;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/surface-matrix.test.ts
export interface SurfaceMatrixMeta {
    base: string;
    changedFileCount: number;
    head: string;
}

/**
 * Renders the checklist an agent pastes into the pull-request body. Every proof row starts `PENDING`; the
 * `pull-request` skill requires each row to become `done` or `waived: <reason>` before the PR is ready, so a reviewer
 * never has to infer whether a listed proof was actually run.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/surface-matrix.test.ts
export function renderSurfaceMatrixMarkdown(
    result: SurfaceMatrixResult,
    meta: SurfaceMatrixMeta,
): string {
    const lines: string[] = [
        '## Surface / Proof Matrix',
        '',
        `Diff \`${meta.base}...${meta.head}\` touches ${meta.changedFileCount} file${meta.changedFileCount === 1 ? '' : 's'}.`,
        '',
    ];
    if (result.entries.length === 0) {
        lines.push('No tracked product surface matched the changed files.');
    } else {
        lines.push(
            '| Surface | Touched files | Required proof | Status |',
            '| --- | --- | --- | --- |',
        );
        for (const entry of result.entries) {
            lines.push(
                `| ${entry.label} | ${formatFileList(entry.files)} | ${entry.proof} | PENDING: mark \`done\` or \`waived: <reason>\` |`,
            );
        }
    }
    if (result.unclassifiedFiles.length > 0) {
        lines.push(
            '',
            `Unclassified (no required proof): ${formatFileList(result.unclassifiedFiles)}`,
        );
    }
    lines.push(
        '',
        '### Reverse-state check',
        '',
        'A one-way door is a bug: confirm this diff does not add a user action (create, enable, start, connect, grant, subscribe, register, mount, show, expand, pin, lock, suspend, ...) without also shipping (or explicitly deferring, with a stated reason) its reverse (delete, disable, stop, disconnect, revoke, unsubscribe, unregister, unmount, hide, collapse, unpin, unlock, resume, ...).',
    );
    if (!result.reverseState.evaluated) {
        lines.push(
            'Diff content was not supplied to this run (`--files` mode); confirm manually whether this diff introduces a new one-way user action.',
        );
    } else if (result.reverseState.gaps.length > 0) {
        lines.push(
            `Added lines mention the following actions without their paired reverse action also appearing added: ${result.reverseState.gaps.join(', ')}. Confirm the reverse already exists, ships elsewhere in this change, or is explicitly out of scope.`,
        );
    } else {
        lines.push(
            'No one-sided action pair matched the added lines (heuristic); still confirm manually for any action this diff introduces.',
        );
    }
    return lines.join('\n');
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/surface-matrix.test.ts
export interface SurfaceMatrixCliOptions {
    base: string;
    files?: string[];
    json: boolean;
}

const DEFAULT_BASE = 'origin/main';

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/surface-matrix.test.ts
export function parseSurfaceMatrixArguments(argv: readonly string[]): SurfaceMatrixCliOptions {
    let base = DEFAULT_BASE;
    let files: string[] | undefined;
    let isJson = false;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--json') {
            isJson = true;
            continue;
        }
        if (argument === '--base') {
            const value = argv[index + 1];
            if (!value) throw new Error('--base requires a value');
            base = value;
            index += 1;
            continue;
        }
        if (argument === '--files') {
            const value = argv[index + 1];
            if (!value) throw new Error('--files requires a comma-separated value');
            files = value
                .split(',')
                .map((entry) => entry.trim())
                .filter(Boolean);
            index += 1;
            continue;
        }
        throw new Error(`Unknown surface-matrix argument: ${argument}`);
    }
    return { base, files, json: isJson };
}

async function collectChangedFiles(base: string, cwd: string): Promise<string[]> {
    const { stdout } = await execFileAsync(
        'git',
        ['diff', '--no-renames', '--name-only', '-z', `${base}...HEAD`],
        { cwd, maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout.split('\0').filter(Boolean);
}

async function collectDiffText(base: string, cwd: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['diff', '--no-renames', `${base}...HEAD`], {
        cwd,
        maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
}

async function resolveHeadLabel(cwd: string): Promise<string> {
    try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd });
        return stdout.trim() || 'HEAD';
    } catch {
        return 'HEAD';
    }
}

async function main(): Promise<void> {
    const options = parseSurfaceMatrixArguments(process.argv.slice(2));
    const projectRoot = resolve(import.meta.dirname, '..');
    const hasExplicitFiles = options.files !== undefined;
    const changedFiles = options.files ?? (await collectChangedFiles(options.base, projectRoot));
    const diffText = hasExplicitFiles
        ? undefined
        : await collectDiffText(options.base, projectRoot);
    const result = buildSurfaceMatrix({ changedFiles, diffText });

    if (options.json) {
        console.log(
            JSON.stringify(
                {
                    base: hasExplicitFiles ? undefined : options.base,
                    changedFileCount: changedFiles.length,
                    ...result,
                },
                undefined,
                2,
            ),
        );
        return;
    }

    const head = hasExplicitFiles ? 'provided file list' : await resolveHeadLabel(projectRoot);
    console.log(
        renderSurfaceMatrixMarkdown(result, {
            base: hasExplicitFiles ? 'n/a' : options.base,
            changedFileCount: changedFiles.length,
            head,
        }),
    );
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
