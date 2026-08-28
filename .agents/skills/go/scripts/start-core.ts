import { resolve } from 'node:path';

import { createWorktree } from '../../switch-worktree/scripts/worktree';
import { captureCommand } from './command-runner';

export interface StartInput {
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
    capture(command: string, arguments_: string[], cwd: string): Promise<string>;
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

async function capture(command: string, arguments_: string[], cwd: string): Promise<string> {
    return captureCommand(command, arguments_, { cwd });
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
    const arguments_ = [
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
    if (input.runId) arguments_.push('--run-id', input.runId);
    return capture('bun', arguments_, worktreePath);
}

/**
 * State initialization imports `@caxri/utils` through its built runtime export. A fresh worktree installs dependencies
 * but has no ignored `packages/utils/dist`, so build that owning package before loading the state CLI.
 */
async function prepareStateRuntime(
    worktreePath: string,
    run: StartDependencies['capture'],
): Promise<void> {
    await run('bun', ['run', '--cwd', 'packages/utils', 'build'], worktreePath);
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
    const runCapture = (command: string, arguments_: string[], path: string) =>
        dependencies.capture(command, arguments_, path);
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
    if (createdHeadSha !== baseSha || createdBranch !== input.branch) {
        throw new Error('Go worktree must start on the requested branch at the pinned origin/main');
    }
    await prepareStateRuntime(created.path, (command, arguments_, path) =>
        dependencies.capture(command, arguments_, path),
    );
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
