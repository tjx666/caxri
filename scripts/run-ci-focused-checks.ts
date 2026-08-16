#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import process from 'node:process';

import type { CIChecksScope } from './ci-execution-plan';

const projectRoot = resolve(import.meta.dirname, '..');

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/run-ci-focused-checks.test.ts
export function focusedCheckArguments(
    paths: readonly string[],
    scope: Extract<CIChecksScope, 'focused-docs' | 'focused-skills' | 'focused-source'>,
): string[] {
    return [
        'run',
        '--silent',
        'check',
        ...paths,
        '--lint',
        '--test',
        ...(scope === 'focused-docs' ? [] : ['--type']),
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
    const child = spawn(command, arguments_, { cwd: projectRoot, stdio: 'inherit' });
    return new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
}

async function main(): Promise<void> {
    const scope = process.env.CI_CHECKS_SCOPE;
    if (scope !== 'focused-docs' && scope !== 'focused-skills' && scope !== 'focused-source') {
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

    if (currentFiles.length === 0) {
        const typeResult = scope === 'focused-docs' ? 0 : await run('bun', ['run', 'typecheck']);
        if (typeResult !== 0) process.exitCode = typeResult;
        else if (shouldRunSkillRegressions(scope)) {
            process.exitCode = await run('bunx', [
                'vitest',
                'run',
                '--silent=passed-only',
                '.agents/skills',
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
    if (diffResult !== 0 || !shouldRunSkillRegressions(scope)) {
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
        '.agents/skills',
    ]);
}

if (import.meta.main) await main();
