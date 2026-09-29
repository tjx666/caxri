import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';

import type {
    GitRepositorySummary,
    GitSummary,
    MobileChangesDiffResult,
    MobileChangesListResult,
} from '@caxri/protocol';
import {
    CaxriError,
    MOBILE_CHANGES_MAX_FILES,
    MOBILE_CHANGES_MAX_PATCH_BYTES,
    MOBILE_CHANGES_MAX_PATCH_LINES,
} from '@caxri/protocol';

import { lineCount, readWorkingFile } from './working-file-reads';

const MAX_LIST_BYTES = 48 * 1_024;

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

function status(kind: GitRepositorySummary['files'][number]['kind']): 'M' | 'A' | 'D' | 'R' {
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

function mobileChangesList(repo: GitRepositorySummary | undefined): MobileChangesListResult {
    if (!repo)
        return {
            isRepository: false,
            files: [],
            total: 0,
            additions: 0,
            deletions: 0,
            truncated: false,
        };
    const sourceFiles = repo.files
        .slice(0, MOBILE_CHANGES_MAX_FILES)
        .filter(
            (file) =>
                Buffer.byteLength(file.path, 'utf8') <= 2_048 &&
                (!file.originalPath || Buffer.byteLength(file.originalPath, 'utf8') <= 2_048),
        );
    const files: MobileChangesListResult['files'] = [];
    // The status snapshot measures each file (see `withFileLineStats`); its repository totals cover only the tracked
    // diff, so the lines of new files are added here.
    let additions = repo.head ? repo.additions : 0;
    const deletions = repo.head ? repo.deletions : 0;
    for (const file of sourceFiles) {
        if (files.length >= MOBILE_CHANGES_MAX_FILES) break;
        const fileAdditions = file.additions ?? 0;
        const fileDeletions = file.deletions ?? 0;
        if (file.kind === 'untracked' || !repo.head) additions += fileAdditions;
        const candidate = {
            repositoryId: repo.id,
            repositoryName: boundedRepoName(repo.name),
            path: file.path,
            ...(file.originalPath && { originalPath: file.originalPath }),
            status: status(file.kind),
            ...(file.additions !== undefined && {
                additions: fileAdditions,
                deletions: fileDeletions,
            }),
        };
        if (
            Buffer.byteLength(JSON.stringify({ files: [...files, candidate] }), 'utf8') >
            MAX_LIST_BYTES
        )
            break;
        files.push(candidate);
    }
    return {
        isRepository: true,
        files,
        total: repo.changedFileCount,
        additions,
        deletions,
        truncated: repo.truncated || files.length < repo.changedFileCount,
    };
}

/**
 * Preserves the 64 KiB sealed frame budget even when one Session has many repositories.
 */
export function mobileChangesListForSummary(summary: GitSummary): MobileChangesListResult {
    const projections = summary.repositories.map((repo) => mobileChangesList(repo));
    const result: MobileChangesListResult = {
        isRepository: summary.isRepository,
        files: [],
        total: 0,
        additions: 0,
        deletions: 0,
        truncated: false,
    };
    for (const projection of projections) {
        result.total += projection.total;
        result.additions += projection.additions;
        result.deletions += projection.deletions;
        result.truncated ||= projection.truncated;
        projection.files.forEach((file) => {
            if (
                result.files.length >= MOBILE_CHANGES_MAX_FILES ||
                Buffer.byteLength(
                    JSON.stringify({ ...result, files: [...result.files, file] }),
                    'utf8',
                ) > MAX_LIST_BYTES
            ) {
                result.truncated = true;
                return;
            }
            result.files.push(file);
        });
    }
    result.truncated ||= result.files.length < result.total;
    return result;
}

export async function mobileChangesDiff(
    repo: GitRepositorySummary | undefined,
    path: string,
    git: (root: string, arguments_: string[], maxBufferBytes?: number) => Promise<string>,
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
    let patch: string;
    try {
        patch = await git(
            repo.rootPath,
            [
                'diff',
                '--no-ext-diff',
                '--no-textconv',
                '--no-color',
                '--find-renames',
                ...(repo.head ? ['HEAD'] : ['--cached']),
                '--',
                ...(file.originalPath ? [file.originalPath] : []),
                file.path,
            ],
            MOBILE_CHANGES_MAX_PATCH_BYTES + 4_096,
        );
    } catch (error) {
        if (
            error instanceof CaxriError &&
            error.code === 'GIT' &&
            error.message === 'Git output exceeded the safety limit.'
        )
            return { status: 'oversized' };
        throw error;
    }
    if (!patch) return { status: 'stale' };
    if (/^Binary files .* differ$/mu.test(patch)) return { status: 'binary' };
    return isPatchOversized(patch) ? { status: 'oversized' } : { status: 'available', patch };
}
