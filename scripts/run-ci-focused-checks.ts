#!/usr/bin/env bun

import { access } from 'node:fs/promises';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

import type { CIChecksScope } from './ci-execution-plan';

const projectRoot = resolve(import.meta.dirname, '..');

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

export function focusedDiffArguments(paths: readonly string[]): string[] {
    return ['diff', '--exit-code', '--', ...paths];
}

export function shouldRunSkillRegressions(scope: CIChecksScope): boolean {
    return scope === 'focused-skills';
}

function validatePath(path: string): string {
    const normalized = normalize(path);
    if (
        !path ||
        isAbsolute(path) ||
        normalized === '..' ||
        normalized.startsWith(`..${sep}`) ||
        path.includes('\0')
    ) {
        throw new Error(`Invalid changed path: ${JSON.stringify(path)}`);
    }
    return normalized;
}

async function run(command: string, args: string[]): Promise<number> {
    const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit' });
    return await new Promise<number>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
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
            changedFiles.map(async (path) =>
                access(resolve(projectRoot, path)).then(
                    () => path,
                    () => undefined,
                ),
            ),
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
    /** Skill-only PRs still run every repository-skill regression, including unchanged routers. */
    process.exitCode = await run('bunx', [
        'vitest',
        'run',
        '--silent=passed-only',
        '.agents/skills',
    ]);
}

if (import.meta.main) await main();
