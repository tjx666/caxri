#!/usr/bin/env bun

import { Buffer } from 'node:buffer';
import { access, appendFile, mkdir, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { execFileAsync, runChildProcess } from './exec';

const projectRoot = resolve(import.meta.dirname, '..');

function requiredEnvironment(environment: NodeJS.ProcessEnv, key: string): string {
    const value = environment[key];
    if (!value || value.includes('\n')) throw new Error(`${key} is required and must be one line`);
    return value;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-concurrent-validation.test.ts
export function checksWorktreePath(environment: NodeJS.ProcessEnv): string {
    const temporaryRoot = resolve(requiredEnvironment(environment, 'TMPDIR'));
    const owner = requiredEnvironment(environment, 'CAXRI_RUNNER_OWNER');
    if (!/^caxri-\d+-\d+-e2e$/u.test(owner)) throw new Error('Invalid E2E runner owner');
    if (temporaryRoot !== join('/private/tmp', owner)) {
        throw new Error('E2E TMPDIR does not match the owned short temporary path');
    }
    return join(temporaryRoot, 'synthetic-merge-checks');
}

/**
 * Supplies GitHub's job token to one fetch through command-scoped Git configuration. The exact-head checkout
 * deliberately removes persisted credentials, so the token must not be written back into the repository config.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-concurrent-validation.test.ts
export function authenticatedGitEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const existingCount = environment.GIT_CONFIG_COUNT ?? '0';
    if (!/^\d+$/u.test(existingCount) || Number(existingCount) > 32) {
        throw new Error('Invalid GIT_CONFIG_COUNT');
    }
    const index = Number(existingCount);
    const token = requiredEnvironment(environment, 'CAXRI_GITHUB_TOKEN');
    const authorization = Buffer.from(`x-access-token:${token}`).toString('base64');
    return {
        ...environment,
        GIT_CONFIG_COUNT: String(index + 1),
        [`GIT_CONFIG_KEY_${index}`]: 'http.https://github.com/.extraheader',
        [`GIT_CONFIG_VALUE_${index}`]: `AUTHORIZATION: basic ${authorization}`,
    };
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-concurrent-validation.test.ts
export function sanitizedChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const sanitized = { ...environment };
    delete sanitized.CAXRI_GITHUB_TOKEN;
    return sanitized;
}

async function isPathPresent(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Exact-head E2E uses a shallow checkout, so GitHub's synthetic PR merge commit may not exist in the local object
 * database. Fetch only the already validated immutable SHA before creating the detached checks worktree; push runs
 * normally take the fast path because HEAD already owns it.
 */
function validateFetchReference(value: string): string {
    if (
        /^[0-9a-f]{40}$/u.test(value) ||
        /^refs\/pull\/\d+\/merge$/u.test(value) ||
        /^refs\/heads\/[A-Za-z0-9][\w./-]*$/u.test(value)
    ) {
        return value;
    }
    throw new Error('Invalid checks fetch ref');
}

async function isCommitAvailable(revision: string): Promise<boolean> {
    const commitObject = [revision, '^{commit}'].join('');
    try {
        await execFileAsync('git', ['cat-file', '-e', commitObject], {
            cwd: projectRoot,
            env: sanitizedChildEnvironment(process.env),
        });
        return true;
    } catch {
        return false;
    }
}

async function ensureRevisionAvailable(
    expectedRevision: string | undefined,
    fetchReference: string,
): Promise<string> {
    if (expectedRevision && /^0+$/u.test(expectedRevision)) return expectedRevision;
    const mustVerifyRemoteReference = fetchReference.startsWith('refs/pull/');
    if (
        expectedRevision &&
        !mustVerifyRemoteReference &&
        (await isCommitAvailable(expectedRevision))
    ) {
        return expectedRevision;
    }

    await execFileAsync('git', ['fetch', '--no-tags', '--depth=1', 'origin', fetchReference], {
        cwd: projectRoot,
        env: authenticatedGitEnvironment(process.env),
    });
    const { stdout } = await execFileAsync('git', ['rev-parse', 'FETCH_HEAD'], {
        cwd: projectRoot,
        env: sanitizedChildEnvironment(process.env),
    });
    const fetchedRevision = stdout.trim();
    if (!/^[0-9a-f]{40}$/u.test(fetchedRevision))
        throw new Error('Invalid fetched checks revision');
    if (expectedRevision && fetchedRevision !== expectedRevision) {
        throw new Error('Fetched checks revision mismatch');
    }
    if (!(await isCommitAvailable(fetchedRevision))) {
        throw new Error('Fetched checks revision is not a commit');
    }
    return fetchedRevision;
}

async function verifyRevisionProvenance(
    revision: string,
    baseRevision: string,
    headRevision: string,
    isMergeRequired: boolean,
): Promise<void> {
    if (!isMergeRequired) {
        if (revision !== headRevision) throw new Error('Exact checks revision does not match head');
        return;
    }
    const { stdout } = await execFileAsync('git', ['show', '-s', '--format=%P', revision], {
        cwd: projectRoot,
        env: sanitizedChildEnvironment(process.env),
    });
    const parents = stdout.trim().split(/\s+/u);
    if (parents.length !== 2 || parents[0] !== baseRevision || parents[1] !== headRevision) {
        throw new Error('Synthetic merge parents do not match the PR base and head');
    }
}

async function createSharedCheckout(path: string, revision: string): Promise<void> {
    await execFileAsync('git', ['clone', '--shared', '--no-checkout', projectRoot, path], {
        cwd: projectRoot,
        env: sanitizedChildEnvironment(process.env),
    });
    await execFileAsync('git', ['checkout', '--detach', revision], {
        cwd: path,
        env: sanitizedChildEnvironment(process.env),
    });
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: path,
        env: sanitizedChildEnvironment(process.env),
    });
    if (stdout.trim() !== revision) throw new Error('Checks checkout revision mismatch');
}

async function runInChecksWorktree(
    worktree: string,
    label: string,
    command: string,
    arguments_: string[],
): Promise<void> {
    const result = await runChildProcess(
        'bun',
        ['run', 'scripts/ci-metrics.ts', '--label', label, '--', command, ...arguments_],
        { cwd: worktree, env: sanitizedChildEnvironment(process.env), stdio: 'inherit' },
    );
    if (result !== 0) throw new Error(`${label} failed with exit ${result}`);
}

async function prepareCaches(worktree: string): Promise<void> {
    const cacheRoot = join(requiredEnvironment(process.env, 'RUNNER_TOOL_CACHE'), 'caxri');
    const cacheDirectory = join(worktree, '.cache');
    await mkdir(cacheDirectory, { recursive: true });
    await Promise.all([
        symlink(join(cacheRoot, 'eslint'), join(cacheDirectory, 'eslint')),
        symlink(join(cacheRoot, 'prettier'), join(cacheDirectory, 'prettier')),
    ]);
}

async function create(): Promise<void> {
    const revision = requiredEnvironment(process.env, 'CAXRI_CHECKS_REVISION');
    if (!/^[0-9a-f]{40}$/u.test(revision)) throw new Error('Invalid CAXRI_CHECKS_REVISION');
    const headRevision = requiredEnvironment(process.env, 'CAXRI_CHECKS_HEAD_REVISION');
    if (!/^[0-9a-f]{40}$/u.test(headRevision)) throw new Error('Invalid checks head revision');
    const isMergeRequired = requiredEnvironment(process.env, 'CAXRI_CHECKS_REQUIRE_MERGE');
    if (isMergeRequired !== 'true' && isMergeRequired !== 'false') {
        throw new Error('Invalid CAXRI_CHECKS_REQUIRE_MERGE');
    }
    const worktree = checksWorktreePath(process.env);
    if (await isPathPresent(worktree)) {
        throw new Error(`Checks worktree already exists: ${worktree}`);
    }

    const baseRevisionValue = process.env.CAXRI_CHECKS_BASE_REVISION?.trim();
    if (baseRevisionValue && !/^[0-9a-f]{40}$/u.test(baseRevisionValue)) {
        throw new Error('Invalid checks base revision');
    }
    const expectedBaseRevision = baseRevisionValue?.length ? baseRevisionValue : undefined;
    const fetchedRevision = await ensureRevisionAvailable(
        revision,
        validateFetchReference(requiredEnvironment(process.env, 'CAXRI_CHECKS_FETCH_REF')),
    );
    const baseRevision = await ensureRevisionAvailable(
        expectedBaseRevision,
        validateFetchReference(requiredEnvironment(process.env, 'CAXRI_CHECKS_BASE_FETCH_REF')),
    );
    await verifyRevisionProvenance(
        fetchedRevision,
        baseRevision,
        headRevision,
        isMergeRequired === 'true',
    );
    await createSharedCheckout(worktree, fetchedRevision);

    await prepareCaches(worktree);
    await runInChecksWorktree(worktree, 'synthetic merge pnpm registry, unpack, and link', 'pnpm', [
        'install',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--prefer-offline',
        '--no-runtime',
    ]);
    await runInChecksWorktree(worktree, 'synthetic merge Electron download', 'pnpm', [
        'rebuild',
        'electron',
    ]);
    await runInChecksWorktree(worktree, 'synthetic merge Electron native rebuild', 'bun', [
        'run',
        'rebuild',
    ]);

    const githubEnvironment = requiredEnvironment(process.env, 'GITHUB_ENV');
    await appendFile(
        githubEnvironment,
        `CAXRI_CHECKS_WORKTREE=${worktree}\nCAXRI_REACT_DOCTOR_BASE=${baseRevision}\n`,
        'utf8',
    );
}

async function remove(): Promise<void> {
    const worktree = checksWorktreePath(process.env);
    if (await isPathPresent(worktree)) {
        await rm(worktree, { recursive: true });
    }
}

async function main(): Promise<void> {
    const [command] = process.argv.slice(2);
    if (command === 'create') await create();
    else if (command === 'remove') await remove();
    else throw new Error('Usage: ci-checks-worktree.ts <create|remove>');
}

if (import.meta.main) await main();
