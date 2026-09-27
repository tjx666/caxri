#!/usr/bin/env bun

import { access } from 'node:fs/promises';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import process from 'node:process';

import type { CIChecksScope } from './ci-execution-plan';
import { runChildProcess } from './exec';

const projectRoot = resolve(import.meta.dirname, '..');

type FocusedChecksScope = Extract<
    CIChecksScope,
    | 'affected'
    | 'focused-docs'
    | 'focused-e2e'
    | 'focused-harness'
    | 'focused-skills'
    | 'focused-source'
>;

const RELATED_SOURCE_EXTENSIONS = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;

/**
 * `vitest related` follows the whole import graph, so a change deep in a shared package still reaches every suite that
 * transitively imports it — the direct-import heuristic `check --test` uses would miss those.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/run-ci-focused-checks.test.ts
export function affectedTestArguments(paths: readonly string[]): string[] | undefined {
    const sources = paths.filter((path) => RELATED_SOURCE_EXTENSIONS.test(path));
    if (sources.length === 0) return undefined;
    return ['vitest', 'related', '--run', '--passWithNoTests', '--silent=passed-only', ...sources];
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/run-ci-focused-checks.test.ts
export function focusedCheckArguments(
    paths: readonly string[],
    scope: FocusedChecksScope,
): string[] {
    return [
        'run',
        '--silent',
        'check',
        ...paths,
        '--lint',
        ...(scope === 'focused-e2e' || scope === 'affected' ? [] : ['--test']),
        ...(scope === 'focused-docs' || scope === 'focused-harness' ? [] : ['--type']),
    ];
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/run-ci-focused-checks.test.ts
export function focusedDiffArguments(paths: readonly string[]): string[] {
    return ['diff', '--exit-code', '--', ...paths];
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/run-ci-focused-checks.test.ts
export function shouldRunSkillRegressions(scope: CIChecksScope): boolean {
    return scope === 'focused-skills';
}

const SKILL_INVOCATION_CONTRACT_TEST = 'scripts/__tests__/skill-invocation.test.ts';
const PROJECT_HOOK_CONTRACT_TEST = '.agents/skills/acceptance/scripts/project-hook.test.ts';
const SKILL_CONTRACT_ROOT_PATHS = new Set([
    'AGENTS.md',
    'CLAUDE.md',
    '.agents/invocation.md',
    '.claude/skills',
]);

const isSkillContractPath = (path: string): boolean =>
    SKILL_CONTRACT_ROOT_PATHS.has(path) ||
    /^(?:\.agents|\.claude)\/skills\/[^/]+\/SKILL\.md$/u.test(path) ||
    /^(?:\.agents|\.claude)\/skills\/[^/]+\/agents\/[^/]+\.ya?ml$/u.test(path);

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/run-ci-focused-checks.test.ts
export function focusedRegressionPaths(
    scope: CIChecksScope,
    changedFiles: readonly string[],
    currentFiles: readonly string[] = [],
): string[] {
    const paths = new Set<string>();
    const currentFileSet = new Set(currentFiles);
    const deletedFiles = changedFiles.filter((path) => !currentFileSet.has(path));
    if (shouldRunSkillRegressions(scope)) {
        paths.add('.agents/skills');
    }
    if (deletedFiles.some(isSkillContractPath)) {
        paths.add(SKILL_INVOCATION_CONTRACT_TEST);
    }
    if (
        deletedFiles.some(
            (path) =>
                path === '.claude/settings.json' ||
                path === '.codex/hooks.json' ||
                path.startsWith('.agents/acceptance/'),
        )
    ) {
        paths.add(PROJECT_HOOK_CONTRACT_TEST);
    }
    return [...paths];
}

function validatePath(path: string): string {
    const normalized = normalize(path);
    if (
        !path ||
        normalized === '..' ||
        isAbsolute(path) ||
        normalized.startsWith(`..${sep}`) ||
        path.includes('\0')
    ) {
        throw new Error(`Invalid changed path: ${JSON.stringify(path)}`);
    }
    return normalized;
}

async function run(command: string, arguments_: string[]): Promise<number> {
    return runChildProcess(command, arguments_, { cwd: projectRoot, stdio: 'inherit' });
}

async function main(): Promise<void> {
    const scope = process.env.CI_CHECKS_SCOPE;
    if (
        scope !== 'affected' &&
        scope !== 'focused-docs' &&
        scope !== 'focused-e2e' &&
        scope !== 'focused-harness' &&
        scope !== 'focused-skills' &&
        scope !== 'focused-source'
    ) {
        throw new Error(`Unsupported focused checks scope: ${scope ?? 'missing'}`);
    }
    const value: unknown = JSON.parse(process.env.CI_CHANGED_FILES ?? '[]');
    if (!Array.isArray(value) || value.some((path) => typeof path !== 'string')) {
        throw new Error('CI_CHANGED_FILES must be a JSON array of repository paths');
    }
    const changedFiles = value.map(validatePath);
    const currentFiles = (
        await Promise.all(
            changedFiles.map(async (path) => {
                try {
                    await access(resolve(projectRoot, path));
                    return path;
                } catch {
                    return;
                }
            }),
        )
    ).filter((path): path is string => path !== undefined);
    const regressionPaths = focusedRegressionPaths(scope, changedFiles, currentFiles);

    if (currentFiles.length === 0) {
        const isTypecheckRequired = scope !== 'focused-docs' && scope !== 'focused-harness';
        const typeResult = isTypecheckRequired ? await run('bun', ['run', 'typecheck']) : 0;
        if (typeResult !== 0) process.exitCode = typeResult;
        else if (regressionPaths.length > 0) {
            process.exitCode = await run('bunx', [
                'vitest',
                'run',
                '--silent=passed-only',
                ...regressionPaths,
            ]);
        }
        return;
    }
    const changedResult = await run('bun', focusedCheckArguments(currentFiles, scope));
    if (changedResult !== 0) {
        process.exitCode = changedResult;
        return;
    }
    const diffResult = await run('git', focusedDiffArguments(currentFiles));
    if (diffResult !== 0) {
        process.exitCode = diffResult;
        return;
    }
    const affectedArguments =
        scope === 'affected' ? affectedTestArguments(currentFiles) : undefined;
    if (affectedArguments) {
        const affectedResult = await run('bunx', affectedArguments);
        if (affectedResult !== 0) {
            process.exitCode = affectedResult;
            return;
        }
    }
    if (regressionPaths.length === 0) {
        process.exitCode = diffResult;
        return;
    }
    /**
     * Skill-only PRs still run every repository-skill regression, including unchanged routers.
     */
    process.exitCode = await run('bunx', [
        'vitest',
        'run',
        '--silent=passed-only',
        ...regressionPaths,
    ]);
}

if (import.meta.main) await main();
