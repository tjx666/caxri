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
        ...sanitizedChildEnvironment(environment),
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

async function isCommitAvailable(
    revision: string,
    repoRoot = projectRoot,
    environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
    const commitObject = [revision, '^{commit}'].join('');
    try {
        await execFileAsync('git', ['cat-file', '-e', commitObject], {
            cwd: repoRoot,
            env: sanitizedChildEnvironment(environment),
        });
        return true;
    } catch {
        return false;
    }
}

async function ensureRevisionAvailable(
    expectedRevision: string | undefined,
    fetchReference: string,
    repoRoot = projectRoot,
    environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
    if (expectedRevision && /^0+$/u.test(expectedRevision)) return expectedRevision;
    const mustVerifyRemoteReference = fetchReference.startsWith('refs/pull/');
    if (
        expectedRevision &&
        !mustVerifyRemoteReference &&
        (await isCommitAvailable(expectedRevision, repoRoot, environment))
    ) {
        return expectedRevision;
    }

    await execFileAsync('git', ['fetch', '--no-tags', '--depth=1', 'origin', fetchReference], {
        cwd: repoRoot,
        env: authenticatedGitEnvironment(environment),
    });
    const { stdout } = await execFileAsync('git', ['rev-parse', 'FETCH_HEAD'], {
        cwd: repoRoot,
        env: sanitizedChildEnvironment(environment),
    });
    const fetchedRevision = stdout.trim();
    if (!/^[0-9a-f]{40}$/u.test(fetchedRevision))
        throw new Error('Invalid fetched checks revision');
    if (expectedRevision && fetchedRevision !== expectedRevision) {
        throw new Error('Fetched checks revision mismatch');
    }
    if (!(await isCommitAvailable(fetchedRevision, repoRoot, environment))) {
        throw new Error('Fetched checks revision is not a commit');
    }
    return fetchedRevision;
}

async function readMergeBase(
    revision: string,
    baseRevision: string,
    repoRoot: string,
    environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
    try {
        const { stdout } = await execFileAsync('git', ['merge-base', baseRevision, revision], {
            cwd: repoRoot,
            env: sanitizedChildEnvironment(environment),
        });
        const mergeBase = stdout.trim();
        return /^[0-9a-f]{40}$/u.test(mergeBase) ? mergeBase : undefined;
    } catch {
        return undefined;
    }
}

/**
 * React Doctor derives changed scope through `git merge-base`. Depth-one fetches deliberately hide parent traversal, so
 * deepen the two immutable revisions just enough to recover their common history and fail rather than silently falling
 * back to a full-repository scan when that provenance cannot be established.
 */
async function ensureDiffBaseAvailable(
    revision: string,
    baseRevision: string,
    isMergeRequired: boolean,
    repoRoot: string,
    environment: NodeJS.ProcessEnv,
): Promise<void> {
    let mergeBase = await readMergeBase(revision, baseRevision, repoRoot, environment);
    for (const deepenBy of [1, 32, 128]) {
        if (mergeBase) break;
        // eslint-disable-next-line no-await-in-loop -- bounded progressive history fetch avoids a full clone normally
        await execFileAsync(
            'git',
            ['fetch', '--no-tags', `--deepen=${deepenBy}`, 'origin', revision, baseRevision],
            { cwd: repoRoot, env: authenticatedGitEnvironment(environment) },
        );
        // eslint-disable-next-line no-await-in-loop -- re-check after each bounded deepening step
        mergeBase = await readMergeBase(revision, baseRevision, repoRoot, environment);
    }
    if (!mergeBase) {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--is-shallow-repository'], {
            cwd: repoRoot,
            env: sanitizedChildEnvironment(environment),
        });
        if (stdout.trim() === 'true') {
            await execFileAsync(
                'git',
                ['fetch', '--no-tags', '--unshallow', 'origin', revision, baseRevision],
                { cwd: repoRoot, env: authenticatedGitEnvironment(environment) },
            );
            mergeBase = await readMergeBase(revision, baseRevision, repoRoot, environment);
        }
    }
    if (!mergeBase || (isMergeRequired && mergeBase !== baseRevision)) {
        throw new Error('Checks revision does not have the required diff base');
    }
}

/**
 * Reads parents from the commit object's immutable headers instead of revision traversal. A depth-one fetch marks
 * GitHub's synthetic merge commit as shallow, so `git show --format=%P` incorrectly reports no parents even though the
 * raw commit object still records both the reviewed base and exact PR head.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- regression-tested with a depth-one synthetic merge clone
export async function verifyRevisionProvenance(
    revision: string,
    baseRevision: string,
    headRevision: string,
    isMergeRequired: boolean,
    repoRoot = projectRoot,
    environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
    if (!isMergeRequired) {
        if (revision !== headRevision) throw new Error('Exact checks revision does not match head');
        return;
    }
    const { stdout } = await execFileAsync('git', ['cat-file', 'commit', revision], {
        cwd: repoRoot,
        env: sanitizedChildEnvironment(environment),
    });
    const headerEnd = stdout.indexOf('\n\n');
    const headers = headerEnd === -1 ? stdout : stdout.slice(0, headerEnd);
    const parents = headers
        .split('\n')
        .filter((line) => line.startsWith('parent '))
        .map((line) => line.slice('parent '.length));
    if (parents.length !== 2 || parents[0] !== baseRevision || parents[1] !== headRevision) {
        throw new Error('Synthetic merge parents do not match the PR base and head');
    }
}

/**
 * Fetches both immutable revisions directly into an owned repository. Reusing the E2E checkout's object database is
 * unsafe because a shared clone does not carry its shallow/promisor metadata and can report `unable to read tree` for a
 * valid synthetic merge. The command-scoped token is removed with the remote before repository scripts execute.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- regression-tested with a depth-one E2E source checkout
export async function createFetchedCheckout(
    path: string,
    options: {
        baseFetchReference: string;
        expectedBaseRevision?: string;
        expectedRevision: string;
        fetchReference: string;
        headRevision: string;
        isMergeRequired: boolean;
        remoteUrl: string;
    },
    environment: NodeJS.ProcessEnv = process.env,
): Promise<{ baseRevision: string; revision: string }> {
    await execFileAsync('git', ['init', path], {
        cwd: resolve(path, '..'),
        env: sanitizedChildEnvironment(environment),
    });
    await execFileAsync('git', ['remote', 'add', 'origin', options.remoteUrl], {
        cwd: path,
        env: sanitizedChildEnvironment(environment),
    });
    const revision = await ensureRevisionAvailable(
        options.expectedRevision,
        options.fetchReference,
        path,
        environment,
    );
    await execFileAsync('git', ['checkout', '--detach', revision], {
        cwd: path,
        env: sanitizedChildEnvironment(environment),
    });
    const baseRevision = await ensureRevisionAvailable(
        options.expectedBaseRevision,
        options.baseFetchReference,
        path,
        environment,
    );
    await ensureDiffBaseAvailable(
        revision,
        baseRevision,
        options.isMergeRequired,
        path,
        environment,
    );
    await verifyRevisionProvenance(
        revision,
        baseRevision,
        options.headRevision,
        options.isMergeRequired,
        path,
        environment,
    );
    await execFileAsync('git', ['remote', 'remove', 'origin'], {
        cwd: path,
        env: sanitizedChildEnvironment(environment),
    });
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: path,
        env: sanitizedChildEnvironment(environment),
    });
    if (stdout.trim() !== revision) throw new Error('Checks checkout revision mismatch');
    return { baseRevision, revision };
}

async function runInChecksWorktree(
    worktree: string,
    label: string,
    command: string,
    arguments_: string[],
    environment: NodeJS.ProcessEnv,
): Promise<void> {
    const result = await runChildProcess(
        'bun',
        ['run', 'scripts/ci-metrics.ts', '--label', label, '--', command, ...arguments_],
        { cwd: worktree, env: sanitizedChildEnvironment(environment), stdio: 'inherit' },
    );
    if (result !== 0) throw new Error(`${label} failed with exit ${result}`);
}

async function prepareCaches(worktree: string, environment: NodeJS.ProcessEnv): Promise<void> {
    const cacheRoot = join(requiredEnvironment(environment, 'RUNNER_TOOL_CACHE'), 'caxri');
    const cacheDirectory = join(worktree, '.cache');
    await mkdir(cacheDirectory, { recursive: true });
    await Promise.all([
        symlink(join(cacheRoot, 'eslint'), join(cacheDirectory, 'eslint')),
        symlink(join(cacheRoot, 'prettier'), join(cacheDirectory, 'prettier')),
    ]);
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- the concurrent runner overlaps checkout preparation with E2E setup
export async function prepareChecksWorktree(
    environment: NodeJS.ProcessEnv = process.env,
): Promise<{ baseRevision: string; worktree: string }> {
    const revision = requiredEnvironment(environment, 'CAXRI_CHECKS_REVISION');
    if (!/^[0-9a-f]{40}$/u.test(revision)) throw new Error('Invalid CAXRI_CHECKS_REVISION');
    const headRevision = requiredEnvironment(environment, 'CAXRI_CHECKS_HEAD_REVISION');
    if (!/^[0-9a-f]{40}$/u.test(headRevision)) throw new Error('Invalid checks head revision');
    const isMergeRequired = requiredEnvironment(environment, 'CAXRI_CHECKS_REQUIRE_MERGE');
    if (isMergeRequired !== 'true' && isMergeRequired !== 'false') {
        throw new Error('Invalid CAXRI_CHECKS_REQUIRE_MERGE');
    }
    const worktree = checksWorktreePath(environment);
    if (await isPathPresent(worktree)) {
        throw new Error(`Checks worktree already exists: ${worktree}`);
    }

    const baseRevisionValue = environment.CAXRI_CHECKS_BASE_REVISION?.trim();
    if (baseRevisionValue && !/^[0-9a-f]{40}$/u.test(baseRevisionValue)) {
        throw new Error('Invalid checks base revision');
    }
    const expectedBaseRevision = baseRevisionValue?.length ? baseRevisionValue : undefined;
    const { stdout: remoteOutput } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
        cwd: projectRoot,
        env: sanitizedChildEnvironment(environment),
    });
    const remoteUrl = remoteOutput.trim();
    if (!remoteUrl || remoteUrl.includes('\n')) throw new Error('Invalid checks remote URL');
    const { baseRevision } = await createFetchedCheckout(
        worktree,
        {
            baseFetchReference: validateFetchReference(
                requiredEnvironment(environment, 'CAXRI_CHECKS_BASE_FETCH_REF'),
            ),
            expectedBaseRevision,
            expectedRevision: revision,
            fetchReference: validateFetchReference(
                requiredEnvironment(environment, 'CAXRI_CHECKS_FETCH_REF'),
            ),
            headRevision,
            isMergeRequired: isMergeRequired === 'true',
            remoteUrl,
        },
        environment,
    );

    await prepareCaches(worktree, environment);
    await runInChecksWorktree(
        worktree,
        'synthetic merge pnpm registry, unpack, and link',
        'pnpm',
        ['install', '--frozen-lockfile', '--ignore-scripts', '--prefer-offline', '--no-runtime'],
        environment,
    );
    await runInChecksWorktree(
        worktree,
        'synthetic merge Electron download',
        'pnpm',
        ['rebuild', 'electron'],
        environment,
    );
    await runInChecksWorktree(
        worktree,
        'synthetic merge Electron native rebuild',
        'bun',
        ['run', 'rebuild'],
        environment,
    );

    const githubEnvironment = requiredEnvironment(environment, 'GITHUB_ENV');
    await appendFile(
        githubEnvironment,
        `CAXRI_CHECKS_WORKTREE=${worktree}\nCAXRI_REACT_DOCTOR_BASE=${baseRevision}\n`,
        'utf8',
    );
    return { baseRevision, worktree };
}

async function remove(): Promise<void> {
    const worktree = checksWorktreePath(process.env);
    if (await isPathPresent(worktree)) {
        await rm(worktree, { recursive: true });
    }
}

async function main(): Promise<void> {
    const [command] = process.argv.slice(2);
    if (command === 'create') await prepareChecksWorktree();
    else if (command === 'remove') await remove();
    else throw new Error('Usage: ci-checks-worktree.ts <create|remove>');
}

if (import.meta.main) await main();
