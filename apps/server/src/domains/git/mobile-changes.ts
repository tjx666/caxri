import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';

import type {
    GitCommitDetails,
    GitCommitFile,
    GitPullRequestChanges,
    GitRepositorySummary,
    GitSummary,
    MobileChangesContext,
    MobileChangesDiffResult,
    MobileChangesListResult,
    MobileChangesMode,
} from '@caxri/protocol';
import {
    CaxriError,
    MOBILE_CHANGES_MAX_FILES,
    MOBILE_CHANGES_MAX_PATCH_BYTES,
    MOBILE_CHANGES_MAX_PATCH_LINES,
} from '@caxri/protocol';

import { lineCount, readWorkingFile } from './working-file-reads';

const MAX_LIST_BYTES = 48 * 1_024;
const MAX_CONTEXT_TEXT_BYTES = 300;

function boundedRepoName(name: string): string {
    let result = '';
    for (const character of name) {
        if (Buffer.byteLength(result + character, 'utf8') > 100) break;
        result += character;
    }
    return result || 'Repository';
}

function isPatchOversized(patch: string): boolean {
    return (
        Buffer.byteLength(patch, 'utf8') > MOBILE_CHANGES_MAX_PATCH_BYTES ||
        Buffer.byteLength(JSON.stringify({ status: 'available', patch }), 'utf8') >
            MOBILE_CHANGES_MAX_PATCH_BYTES ||
        patch.split('\n').length > MOBILE_CHANGES_MAX_PATCH_LINES
    );
}

type MobileFileStatus = MobileChangesListResult['files'][number]['status'];

function workingStatus(kind: GitRepositorySummary['files'][number]['kind']): MobileFileStatus {
    switch (kind) {
        case 'added':
        case 'untracked':
            return 'A';
        case 'deleted':
            return 'D';
        case 'renamed':
            return 'R';
        default:
            return 'M';
    }
}

function commitStatus(status: GitCommitFile['status']): MobileFileStatus {
    switch (status) {
        case 'added':
        case 'copied':
            return 'A';
        case 'deleted':
            return 'D';
        case 'renamed':
            return 'R';
        default:
            return 'M';
    }
}

/**
 * One repository's change set in any Changes mode, before the phone's count and byte bounds apply.
 */
interface MobileChangeSet {
    repositoryId: string;
    repositoryName: string;
    files: ReadonlyArray<{
        path: string;
        originalPath?: string;
        status: MobileFileStatus;
        additions?: number;
        deletions?: number;
    }>;
    total: number;
    additions: number;
    deletions: number;
    truncated: boolean;
}

function workingChangeSet(repo: GitRepositorySummary): MobileChangeSet {
    // The status snapshot measures each file (see `withFileLineStats`); its repository totals cover only the tracked
    // diff, so the lines of new files are added here.
    let additions = repo.head ? repo.additions : 0;
    for (const file of repo.files)
        if (file.kind === 'untracked' || !repo.head) additions += file.additions ?? 0;
    return {
        repositoryId: repo.id,
        repositoryName: repo.name,
        files: repo.files.map((file) => ({ ...file, status: workingStatus(file.kind) })),
        total: repo.changedFileCount,
        additions,
        deletions: repo.head ? repo.deletions : 0,
        truncated: repo.truncated,
    };
}

function commitChangeSet(repo: GitRepositorySummary, details: GitCommitDetails): MobileChangeSet {
    return {
        repositoryId: repo.id,
        repositoryName: repo.name,
        files: details.files.map((file) => ({
            path: file.path,
            ...(file.previousPath && { originalPath: file.previousPath }),
            status: commitStatus(file.status),
            additions: file.additions,
            deletions: file.deletions,
        })),
        total: details.files.length,
        additions: details.additions,
        deletions: details.deletions,
        truncated: details.filesTruncated,
    };
}

function pullRequestChangeSet(
    repo: GitRepositorySummary,
    pullRequest: GitPullRequestChanges,
): MobileChangeSet {
    return {
        repositoryId: repo.id,
        repositoryName: repo.name,
        files: pullRequest.files.map((file) => ({ ...file, status: workingStatus(file.kind) })),
        total: pullRequest.files.length,
        additions: pullRequest.additions,
        deletions: pullRequest.deletions,
        truncated: false,
    };
}

/**
 * A commit subject or pull request title only labels the list, so it is bounded well below the protocol cap to keep a
 * many-repository context list inside one sealed reply frame.
 */
function boundedContextText(text: string): string {
    let result = '';
    for (const character of text) {
        if (Buffer.byteLength(result + character, 'utf8') > MAX_CONTEXT_TEXT_BYTES) break;
        result += character;
    }
    return result;
}

/**
 * Preserves the 64 KiB sealed frame budget even when one Session has many repositories.
 */
function mobileChangesListForChangeSets({
    contexts = [],
    isRepository,
    sets,
    uncommittedCount,
}: {
    contexts?: MobileChangesContext[];
    isRepository: boolean;
    sets: readonly MobileChangeSet[];
    uncommittedCount: number;
}): MobileChangesListResult {
    const result: MobileChangesListResult = {
        isRepository,
        uncommittedCount,
        contexts,
        files: [],
        total: 0,
        additions: 0,
        deletions: 0,
        truncated: false,
    };
    for (const set of sets) {
        result.total += set.total;
        result.additions += set.additions;
        result.deletions += set.deletions;
        result.truncated ||= set.truncated;
        appendChangeSetFiles(result, set);
    }
    result.truncated ||= result.files.length < result.total;
    return result;
}

/**
 * Adds one repository's files until the count or byte budget runs out, marking the result truncated when it does.
 */
function appendChangeSetFiles(result: MobileChangesListResult, set: MobileChangeSet): void {
    const repoName = boundedRepoName(set.repositoryName);
    for (const file of set.files) {
        if (
            Buffer.byteLength(file.path, 'utf8') > 2_048 ||
            (file.originalPath && Buffer.byteLength(file.originalPath, 'utf8') > 2_048)
        )
            continue;
        const candidate = {
            repositoryId: set.repositoryId,
            repositoryName: repoName,
            path: file.path,
            ...(file.originalPath && { originalPath: file.originalPath }),
            status: file.status,
            ...(file.additions !== undefined && {
                additions: file.additions,
                deletions: file.deletions ?? 0,
            }),
        };
        if (
            result.files.length >= MOBILE_CHANGES_MAX_FILES ||
            Buffer.byteLength(
                JSON.stringify({ ...result, files: [...result.files, candidate] }),
                'utf8',
            ) > MAX_LIST_BYTES
        ) {
            result.truncated = true;
            return;
        }
        result.files.push(candidate);
    }
}

function uncommittedCount(summary: GitSummary): number {
    return summary.repositories.reduce((count, repo) => count + repo.changedFileCount, 0);
}

export function mobileChangesListForSummary(summary: GitSummary): MobileChangesListResult {
    return mobileChangesListForChangeSets({
        isRepository: summary.isRepository,
        sets: summary.repositories.map(workingChangeSet),
        uncommittedCount: uncommittedCount(summary),
    });
}

type GitRun = (root: string, arguments_: string[], maxBufferBytes?: number) => Promise<string>;

const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color', '--find-renames'];

async function mobileChangesDiff(
    repo: GitRepositorySummary | undefined,
    path: string,
    git: GitRun,
): Promise<MobileChangesDiffResult> {
    if (!repo) return { status: 'stale' };
    const file = repo.files.find((entry) => entry.path === path);
    if (!file) return { status: 'stale' };
    if (file.kind === 'untracked' || !repo.head) {
        const candidate = resolve(repo.rootPath, file.path);
        try {
            const content = await readWorkingFile(candidate, MOBILE_CHANGES_MAX_PATCH_BYTES);
            if (!content || content.includes(0)) return { status: 'binary' };
            if (lineCount(content) + 4 > MOBILE_CHANGES_MAX_PATCH_LINES)
                return { status: 'oversized' };
            const decoded = new TextDecoder('utf-8', { fatal: true }).decode(content);
            const lines = decoded.split('\n');
            if (lines.at(-1) === '') lines.pop();
            const patch = `--- /dev/null\n+++ b/${file.path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`;
            return isPatchOversized(patch)
                ? { status: 'oversized' }
                : { status: 'available', patch };
        } catch (error) {
            if (error instanceof CaxriError && error.code === 'CAPACITY')
                return { status: 'oversized' };
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'stale' };
            if (error instanceof TypeError) return { status: 'binary' };
            throw error;
        }
    }
    return gitPatch(
        repo.rootPath,
        [
            'diff',
            ...DIFF_FLAGS,
            ...(repo.head ? ['HEAD'] : ['--cached']),
            '--',
            ...(file.originalPath ? [file.originalPath] : []),
            file.path,
        ],
        git,
    );
}

/**
 * Runs one bounded `git diff`/`git show` patch and classifies it the same way for every Changes mode.
 */
async function gitPatch(
    root: string,
    arguments_: string[],
    git: GitRun,
): Promise<MobileChangesDiffResult> {
    let patch: string;
    try {
        patch = await git(root, arguments_, MOBILE_CHANGES_MAX_PATCH_BYTES + 4_096);
    } catch (error) {
        if (
            error instanceof CaxriError &&
            error.code === 'GIT' &&
            error.message === 'Git output exceeded the safety limit.'
        )
            return { status: 'oversized' };
        throw error;
    }
    if (!patch.trim()) return { status: 'stale' };
    if (/^Binary files .* differ$/mu.test(patch)) return { status: 'binary' };
    return isPatchOversized(patch) ? { status: 'oversized' } : { status: 'available', patch };
}

/**
 * One file of the HEAD commit, diffed against its first parent like Desktop's Last Commit mode (`git show` covers the
 * root commit too). A path the commit does not touch, because HEAD moved since the list was read, reads as stale.
 */
function mobileCommitDiff(
    repo: GitRepositorySummary | undefined,
    details: GitCommitDetails | undefined,
    path: string,
    git: GitRun,
): Promise<MobileChangesDiffResult> {
    const file = details?.files.find((entry) => entry.path === path);
    if (!repo || !details || !file) return Promise.resolve({ status: 'stale' });
    return gitPatch(
        repo.rootPath,
        [
            'show',
            ...DIFF_FLAGS,
            '--format=',
            '--first-parent',
            '-m',
            details.commit.sha,
            '--',
            ...(file.previousPath ? [file.previousPath] : []),
            file.path,
        ],
        git,
    );
}

/**
 * One file of the branch's pull request over the same `base...head` range Desktop's Pull Request mode lists.
 */
export function mobilePullRequestDiff(
    repo: GitRepositorySummary | undefined,
    pullRequest: GitPullRequestChanges | null | undefined,
    path: string,
    git: GitRun,
): Promise<MobileChangesDiffResult> {
    const file = pullRequest?.files.find((entry) => entry.path === path);
    if (!repo || !pullRequest || !file) return Promise.resolve({ status: 'stale' });
    return gitPatch(
        repo.rootPath,
        [
            'diff',
            ...DIFF_FLAGS,
            `${pullRequest.baseOid}...${pullRequest.headOid}`,
            '--',
            ...(file.originalPath ? [file.originalPath] : []),
            file.path,
        ],
        git,
    );
}

/**
 * The Git reads the commit and pull request modes need, bound to one Session by the Git service.
 */
export interface MobileChangeReads {
    commitDetails(repoId: string, sha: string): Promise<GitCommitDetails>;
    git: GitRun;
    pullRequestChanges(repoId: string, refresh: number): Promise<GitPullRequestChanges | null>;
}

/**
 * The phone's Changes list in one of Desktop Source Control's three modes. Commit and pull request modes reuse the same
 * `commitDetails` and `pullRequestChanges` reads the Git extension's Last Commit and Pull Request modes use, so both
 * clients list the same files.
 */
export async function readMobileChangesList(
    summary: GitSummary,
    mode: MobileChangesMode = 'working',
    shouldRefresh: boolean,
    reads: MobileChangeReads,
): Promise<MobileChangesListResult> {
    if (mode === 'working') return mobileChangesListForSummary(summary);
    const projections = await Promise.all(
        summary.repositories.map(async (repo) => {
            if (mode === 'commit') {
                if (!repo.head) return;
                const details = await reads.commitDetails(repo.id, repo.head);
                const context: MobileChangesContext = {
                    kind: 'commit',
                    repositoryId: repo.id,
                    shortSha: details.commit.shortSha,
                    subject: boundedContextText(details.commit.subject),
                };
                return { context, set: commitChangeSet(repo, details) };
            }
            const pullRequest = await reads.pullRequestChanges(repo.id, shouldRefresh ? 1 : 0);
            if (!pullRequest) return;
            const context: MobileChangesContext = {
                kind: 'pull-request',
                repositoryId: repo.id,
                number: pullRequest.number,
                title: boundedContextText(pullRequest.title),
            };
            return { context, set: pullRequestChangeSet(repo, pullRequest) };
        }),
    );
    const present = projections.filter((projection) => projection !== undefined);
    return mobileChangesListForChangeSets({
        contexts: present.slice(0, 32).map((projection) => projection.context),
        isRepository: summary.isRepository,
        sets: present.map((projection) => projection.set),
        uncommittedCount: uncommittedCount(summary),
    });
}

export async function readMobileChangesDiff(
    repo: GitRepositorySummary,
    path: string,
    mode: MobileChangesMode = 'working',
    reads: MobileChangeReads,
): Promise<MobileChangesDiffResult> {
    if (mode === 'commit')
        return mobileCommitDiff(
            repo,
            repo.head ? await reads.commitDetails(repo.id, repo.head) : undefined,
            path,
            reads.git,
        );
    if (mode === 'pull-request')
        return mobilePullRequestDiff(
            repo,
            await reads.pullRequestChanges(repo.id, 0),
            path,
            reads.git,
        );
    return mobileChangesDiff(repo, path, reads.git);
}
