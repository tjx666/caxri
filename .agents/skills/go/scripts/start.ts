#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { createWorktree } from '../../switch-worktree/scripts/worktree';

interface StartInput {
    branch: string;
    objective: string;
    runId?: string;
}

interface CheckoutSnapshot {
    branch: string;
    headSha: string;
    status: string;
}

interface StartDependencies {
    capture(command: string, args: string[], cwd: string): Promise<string>;
    create(branch: string, baseSha: string, mainCheckoutPath: string): Promise<{ path: string }>;
    initialize(
        worktreePath: string,
        input: StartInput,
        metadata: { baseSha: string; mainCheckoutPath: string },
    ): Promise<string>;
}

export interface GoStartResult {
    baseSha: string;
    branch: string;
    isolatedFromMain: true;
    mainCheckoutPath: string;
    statePath: string;
    worktreePath: string;
}

async function capture(command: string, args: string[], cwd: string): Promise<string> {
    return await new Promise((resolveOutput, reject) => {
        const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        child.once('error', reject);
        child.once('close', (code) =>
            code === 0
                ? resolveOutput(stdout.trim())
                : reject(new Error(`${command} exited ${String(code)}: ${stderr.trim()}`)),
        );
    });
}

async function checkoutSnapshot(
    path: string,
    run: StartDependencies['capture'],
): Promise<CheckoutSnapshot> {
    const [branch, headSha, status] = await Promise.all([
        run('git', ['branch', '--show-current'], path),
        run('git', ['rev-parse', 'HEAD'], path),
        run('git', ['status', '--porcelain', '--untracked-files=all'], path),
    ]);
    return { branch, headSha, status };
}

async function defaultInitialize(
    worktreePath: string,
    input: StartInput,
    metadata: { baseSha: string; mainCheckoutPath: string },
): Promise<string> {
    const args = [
        'run',
        '.agents/skills/go/scripts/state.ts',
        'init',
        '--objective',
        input.objective,
        '--branch',
        input.branch,
        '--worktree-path',
        worktreePath,
        '--main-checkout-path',
        metadata.mainCheckoutPath,
        '--base-sha',
        metadata.baseSha,
    ];
    if (input.runId) args.push('--run-id', input.runId);
    return capture('bun', args, worktreePath);
}

const defaultDependencies: StartDependencies = {
    capture,
    create: async (branch, baseSha, mainCheckoutPath) =>
        createWorktree({ base: baseSha, branch, cwd: mainCheckoutPath }),
    initialize: defaultInitialize,
};

export async function startGoRun(
    input: StartInput,
    cwd: string,
    dependencies: StartDependencies = defaultDependencies,
): Promise<GoStartResult> {
    const commonDirectory = await dependencies.capture(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        cwd,
    );
    const mainCheckoutPath = resolve(commonDirectory, '..');
    const runCapture = (command: string, args: string[], path: string) =>
        dependencies.capture(command, args, path);
    const before = await checkoutSnapshot(mainCheckoutPath, runCapture);
    await dependencies.capture('git', ['fetch', '--quiet', 'origin', 'main'], mainCheckoutPath);
    const baseSha = await dependencies.capture(
        'git',
        ['rev-parse', 'origin/main'],
        mainCheckoutPath,
    );
    const created = await dependencies.create(input.branch, baseSha, mainCheckoutPath);
    if (resolve(created.path) === resolve(mainCheckoutPath)) {
        throw new Error('Go worktree must be isolated from the main checkout');
    }
    const [createdBranch, createdHeadSha] = await Promise.all([
        dependencies.capture('git', ['branch', '--show-current'], created.path),
        dependencies.capture('git', ['rev-parse', 'HEAD'], created.path),
    ]);
    if (createdBranch !== input.branch || createdHeadSha !== baseSha) {
        throw new Error('Go worktree must start on the requested branch at the pinned origin/main');
    }
    const statePath = await dependencies.initialize(created.path, input, {
        baseSha,
        mainCheckoutPath,
    });
    const after = await checkoutSnapshot(mainCheckoutPath, runCapture);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
        throw new Error('Go startup changed the main checkout branch, HEAD, or working tree');
    }
    return {
        baseSha,
        branch: input.branch,
        isolatedFromMain: true,
        mainCheckoutPath,
        statePath,
        worktreePath: created.path,
    };
}

function parse(argv: string[]): StartInput {
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
        const key = argv[index];
        const value = argv[index + 1];
        if (!key?.startsWith('--') || !value) throw new Error('Expected --option value pairs');
        values.set(key.slice(2), value);
    }
    const objective = values.get('objective');
    const branch = values.get('branch');
    if (!objective || !branch) throw new Error('Go start requires --objective and --branch');
    return { branch, objective, runId: values.get('run-id') };
}

if (import.meta.main) {
    void startGoRun(parse(process.argv.slice(2)), process.cwd())
        .then((result) => console.log(JSON.stringify(result, null, 2)))
        .catch((error: unknown) => {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        });
}
