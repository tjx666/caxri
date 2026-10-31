/**
 * Revision provenance for the `checks` job's synthetic PR merge ref: verifies the merge commit's parents against the PR
 * base and head, and tolerates a base branch that advanced while the run was queued.
 */

import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import process from 'node:process';

import { sanitizedChildEnvironment } from './ci-child-environment';
import { execFileAsync } from './exec';

const projectRoot = resolve(import.meta.dirname, '..');

interface SyntheticMergeBaseDrift {
    /**
     * Base parent recorded by GitHub's live merge ref, i.e. the base branch tip when the ref was computed.
     */
    mergeReferenceBase: string;
    /**
     * Base SHA frozen in the workflow event payload when the run was queued.
     */
    payloadBase: string;
}

interface RevisionProvenance {
    baseDrift?: SyntheticMergeBaseDrift;
    /**
     * The base the checks job must diff against; the merge ref's own base once drift is verified.
     */
    baseRevision: string;
}

interface CaptureProcessOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}

interface CaptureProcessResult {
    stderr: string;
    stdout: string;
}

type CaptureProcess = (
    command: string,
    arguments_: readonly string[],
    options?: CaptureProcessOptions,
) => Promise<CaptureProcessResult>;

async function captureProcess(
    command: string,
    arguments_: readonly string[],
    options: CaptureProcessOptions = {},
): Promise<CaptureProcessResult> {
    const { stderr, stdout } = await execFileAsync(command, [...arguments_], options);
    return { stderr, stdout };
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, key: string): string {
    const value = environment[key];
    if (!value || value.includes('\n')) throw new Error(`${key} is required and must be one line`);
    return value;
}

/**
 * Supplies GitHub's job token to one fetch through command-scoped Git configuration. The exact-head checkout
 * deliberately removes persisted credentials, so the token must not be written back into the repository config.
 */

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

async function isCommitAvailable(
    revision: string,
    repoRoot = projectRoot,
    environment: NodeJS.ProcessEnv = process.env,
    execute: CaptureProcess = captureProcess,
): Promise<boolean> {
    const commitObject = [revision, '^{commit}'].join('');
    try {
        await execute('git', ['cat-file', '-e', commitObject], {
            cwd: repoRoot,
            env: sanitizedChildEnvironment(environment),
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * A fetch starts git's detached auto-maintenance, whose `gc` rewrites `.git/shallow` while the next deepening fetch
 * runs, failing it with "shallow file has changed since we read it" (#1869, hosted-full run 41224291826). This
 * throwaway repository never needs maintenance.
 */
const FETCH_ARGUMENTS = ['fetch', '--no-auto-maintenance', '--no-tags'];

async function ensureRevisionAvailable(
    expectedRevision: string | undefined,
    fetchReference: string,
    repoRoot = projectRoot,
    environment: NodeJS.ProcessEnv = process.env,
    execute: CaptureProcess = captureProcess,
): Promise<string> {
    if (expectedRevision && /^0+$/u.test(expectedRevision)) return expectedRevision;
    const mustVerifyRemoteReference = fetchReference.startsWith('refs/pull/');
    if (
        expectedRevision &&
        !mustVerifyRemoteReference &&
        (await isCommitAvailable(expectedRevision, repoRoot, environment, execute))
    ) {
        return expectedRevision;
    }

    await execute('git', [...FETCH_ARGUMENTS, '--depth=1', 'origin', fetchReference], {
        cwd: repoRoot,
        env: authenticatedGitEnvironment(environment),
    });
    const { stdout } = await execute('git', ['rev-parse', 'FETCH_HEAD'], {
        cwd: repoRoot,
        env: sanitizedChildEnvironment(environment),
    });
    const fetchedRevision = stdout.trim();
    if (!/^[0-9a-f]{40}$/u.test(fetchedRevision))
        throw new Error('Invalid fetched checks revision');
    if (expectedRevision && fetchedRevision !== expectedRevision) {
        throw new Error('Fetched checks revision mismatch');
    }
    if (!(await isCommitAvailable(fetchedRevision, repoRoot, environment, execute))) {
        throw new Error('Fetched checks revision is not a commit');
    }
    return fetchedRevision;
}

async function readMergeBase(
    revision: string,
    baseRevision: string,
    repoRoot: string,
    environment: NodeJS.ProcessEnv,
    execute: CaptureProcess,
): Promise<string | undefined> {
    try {
        const { stdout } = await execute('git', ['merge-base', baseRevision, revision], {
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
    execute: CaptureProcess,
): Promise<string> {
    let mergeBase = await readMergeBase(revision, baseRevision, repoRoot, environment, execute);
    for (const deepenBy of [1, 32, 128]) {
        if (mergeBase) break;
        // eslint-disable-next-line no-await-in-loop -- bounded progressive history fetch avoids a full clone normally
        await execute(
            'git',
            [...FETCH_ARGUMENTS, `--deepen=${deepenBy}`, 'origin', revision, baseRevision],
            { cwd: repoRoot, env: authenticatedGitEnvironment(environment) },
        );
        // eslint-disable-next-line no-await-in-loop -- re-check after each bounded deepening step
        mergeBase = await readMergeBase(revision, baseRevision, repoRoot, environment, execute);
    }
    if (!mergeBase) {
        const { stdout } = await execute('git', ['rev-parse', '--is-shallow-repository'], {
            cwd: repoRoot,
            env: sanitizedChildEnvironment(environment),
        });
        if (stdout.trim() === 'true') {
            await execute(
                'git',
                [...FETCH_ARGUMENTS, '--unshallow', 'origin', revision, baseRevision],
                { cwd: repoRoot, env: authenticatedGitEnvironment(environment) },
            );
            mergeBase = await readMergeBase(revision, baseRevision, repoRoot, environment, execute);
        }
    }
    if (!mergeBase || (isMergeRequired && mergeBase !== baseRevision)) {
        throw new Error('Checks revision does not have the required diff base');
    }
    return mergeBase;
}

const REBASE_REMEDIATION =
    'Rerunning this job reuses the same frozen event payload and cannot recover; rebase the PR onto the latest base branch and force-push to trigger a fresh run.';

function staleSyntheticMergeError(input: {
    headRevision: string;
    mergeReferenceBase: string | undefined;
    mergeReferenceHead: string | undefined;
    payloadBase: string;
}): Error {
    return new Error(
        'Synthetic merge parents do not match the PR base and head: ' +
            `payload base ${input.payloadBase}, merge-ref base ${input.mergeReferenceBase ?? 'missing'}, ` +
            `merge-ref head ${input.mergeReferenceHead ?? 'missing'}, PR head ${input.headRevision}. ` +
            `The merge ref is stale for this head. ${REBASE_REMEDIATION}`,
    );
}

/**
 * Reads parents from the commit object's immutable headers instead of revision traversal. A depth-one fetch marks
 * GitHub's synthetic merge commit as shallow, so `git show --format=%P` incorrectly reports no parents even though the
 * raw commit object still records both the reviewed base and exact PR head.
 *
 * The two parents carry different severities. The second parent is the PR head: a mismatch means GitHub recomputed the
 * merge ref for a newer head and this run's payload can never match it again, so it is a hard failure. The first parent
 * is the base branch tip at the moment the merge ref was computed. It legitimately moves ahead of the payload base
 * whenever another PR lands while this run is queued, and the merge ref still contains the reviewed head, so a
 * forward-only base drift continues with the merge ref's real base instead of aborting. Tracked in #609.
 */

export async function verifyRevisionProvenance(
    revision: string,
    baseRevision: string,
    headRevision: string,
    isMergeRequired: boolean,
    repoRoot = projectRoot,
    environment: NodeJS.ProcessEnv = process.env,
    execute: CaptureProcess = captureProcess,
    log: (message: string) => void = console.log,
): Promise<RevisionProvenance> {
    if (!isMergeRequired) {
        if (revision !== headRevision) throw new Error('Exact checks revision does not match head');
        return { baseRevision };
    }
    const { stdout } = await execute('git', ['cat-file', 'commit', revision], {
        cwd: repoRoot,
        env: sanitizedChildEnvironment(environment),
    });
    const headerEnd = stdout.indexOf('\n\n');
    const headers = headerEnd === -1 ? stdout : stdout.slice(0, headerEnd);
    const parents = headers
        .split('\n')
        .filter((line) => line.startsWith('parent '))
        .map((line) => line.slice('parent '.length));
    const [mergeReferenceBase, mergeReferenceHead] = parents;
    if (parents.length !== 2) {
        throw new Error(
            `Synthetic merge parents do not match the PR base and head: expected two parents, found ${parents.length} ` +
                `(payload base ${baseRevision}, PR head ${headRevision}). ${REBASE_REMEDIATION}`,
        );
    }
    const isStaleHead = mergeReferenceHead !== headRevision;
    if (isStaleHead || !mergeReferenceBase || !/^[0-9a-f]{40}$/u.test(mergeReferenceBase)) {
        throw staleSyntheticMergeError({
            headRevision,
            mergeReferenceBase,
            mergeReferenceHead,
            payloadBase: baseRevision,
        });
    }
    if (mergeReferenceBase === baseRevision) return { baseRevision };

    /**
     * Only a base that moved forward is trusted: the payload base must be an ancestor of the merge ref's base. A
     * rewritten base branch, or a retarget onto history that does not descend from the payload base, fails closed with
     * the same rebase remediation, and so does a fetch or deepening failure while proving that ancestry, so every abort
     * on this path names the SHAs a maintainer needs. A retarget onto a branch cut from the payload base is
     * indistinguishable from ordinary drift and is accepted as such: the merge ref's base is then the PR's real base,
     * so the diff is still taken against the right commit.
     */
    let mergeBase: string | undefined;
    try {
        await ensureRevisionAvailable(
            mergeReferenceBase,
            mergeReferenceBase,
            repoRoot,
            environment,
            execute,
        );
        mergeBase = await ensureDiffBaseAvailable(
            mergeReferenceBase,
            baseRevision,
            false,
            repoRoot,
            environment,
            execute,
        );
    } catch (error: unknown) {
        throw new Error(
            'Synthetic merge parents do not match the PR base and head: ' +
                `could not prove merge-ref base ${mergeReferenceBase} descends from payload base ${baseRevision} ` +
                `(merge-ref head ${mergeReferenceHead}, PR head ${headRevision}). ${REBASE_REMEDIATION}`,
            { cause: error },
        );
    }
    if (mergeBase !== baseRevision) {
        throw new Error(
            'Synthetic merge parents do not match the PR base and head: ' +
                `merge-ref base ${mergeReferenceBase} does not descend from payload base ${baseRevision} ` +
                `(merge-ref head ${mergeReferenceHead}, PR head ${headRevision}). ${REBASE_REMEDIATION}`,
        );
    }
    const baseDrift: SyntheticMergeBaseDrift = { mergeReferenceBase, payloadBase: baseRevision };
    log(`CAXRI_CHECKS_BASE_DRIFT ${JSON.stringify({ headRevision, ...baseDrift })}`);
    log(
        `Synthetic merge base advanced from ${baseRevision} to ${mergeReferenceBase} while this run was queued; ` +
            'continuing with the merge ref base because it still contains the exact PR head.',
    );
    return { baseDrift, baseRevision: mergeReferenceBase };
}
