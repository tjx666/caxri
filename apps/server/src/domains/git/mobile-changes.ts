import { Buffer } from 'node:buffer';
import { lstat } from 'node:fs/promises';
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

import { readBoundedRegularFile } from '../bounded-file-reader';

const MAX_LIST_BYTES = 48 * 1_024;

function lineCount(content: Buffer): number {
    if (content.length === 0) return 0;
    let count = content.at(-1) === 10 ? 0 : 1;
    for (const byte of content) if (byte === 10) count += 1;
    return count;
}

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

async function untrackedLineCount(rootPath: string, path: string): Promise<number> {
    try {
        const candidate = resolve(rootPath, path);
        if (!(await lstat(candidate)).isFile()) return 0;
        const content = await readBoundedRegularFile(candidate, MOBILE_CHANGES_MAX_PATCH_BYTES);
        return content.includes(0) ? 0 : lineCount(content);
    } catch {
        // A moving or oversized untracked file remains visible with unknown line counts.
        return 0;
    }
}

/**
 * Parses Git's NUL-delimited numstat, including its empty-path rename record.
 */
export function parseMobileNumstat(
    output: string,
): Map<string, { additions: number; deletions: number }> {
    const result = new Map<string, { additions: number; deletions: number }>();
    const records = output.split('\0');
    for (let index = 0; index < records.length; index += 1) {
        const fields = /^(\d+|-)\t(\d+|-)\t(.*)$/su.exec(records[index]);
        if (!fields) continue;
        const path = fields[3] || records[(index += 2)];
        if (!path) continue;
        result.set(path, {
            additions: fields[1] === '-' ? 0 : Number(fields[1]),
            deletions: fields[2] === '-' ? 0 : Number(fields[2]),
        });
    }
    return result;
}

async function mobileChangesList(
    repo: GitRepositorySummary | undefined,
    git: (root: string, arguments_: string[], maxBufferBytes?: number) => Promise<string>,
): Promise<MobileChangesListResult> {
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
    const paths = sourceFiles.flatMap((file) =>
        file.originalPath ? [file.originalPath, file.path] : [file.path],
    );
    const stats =
        paths.length === 0 || !repo.head
            ? new Map<string, { additions: number; deletions: number }>()
            : parseMobileNumstat(
                  await git(
                      repo.rootPath,
                      [
                          'diff',
                          '--numstat',
                          '-z',
                          '--no-renames',
                          ...(repo.head ? ['HEAD'] : ['--cached']),
                          '--',
                          ...paths,
                      ],
                      1024 * 1024,
                  ),
              );
    const untrackedCounts = await Promise.all(
        sourceFiles.map((file) =>
            file.kind === 'untracked' || !repo.head
                ? untrackedLineCount(repo.rootPath, file.path)
                : Promise.resolve(0),
        ),
    );
    const files: MobileChangesListResult['files'] = [];
    let additions = repo.head ? repo.additions : 0;
    const deletions = repo.head ? repo.deletions : 0;
    for (const [index, file] of sourceFiles.entries()) {
        if (files.length >= MOBILE_CHANGES_MAX_FILES) break;
        const tracked = stats.get(file.path);
        const oldPath = file.originalPath ? stats.get(file.originalPath) : undefined;
        let fileAdditions = tracked?.additions ?? 0;
        const fileDeletions = repo.head ? (tracked?.deletions ?? 0) + (oldPath?.deletions ?? 0) : 0;
        if (file.kind === 'untracked' || !repo.head) fileAdditions = untrackedCounts[index];
        if (file.kind === 'untracked' || !repo.head) additions += fileAdditions;
        const candidate = {
            repositoryId: repo.id,
            repositoryName: boundedRepoName(repo.name),
            path: file.path,
            ...(file.originalPath && { originalPath: file.originalPath }),
            status: status(file.kind),
            additions: fileAdditions,
            deletions: fileDeletions,
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
export async function mobileChangesListForSummary(
    summary: GitSummary,
    git: (root: string, arguments_: string[], maxBufferBytes?: number) => Promise<string>,
): Promise<MobileChangesListResult> {
    const projections = await Promise.all(
        summary.repositories.map((repo) => mobileChangesList(repo, git)),
    );
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
            if (!(await lstat(candidate)).isFile()) return { status: 'binary' };
            const content = await readBoundedRegularFile(candidate, MOBILE_CHANGES_MAX_PATCH_BYTES);
            if (content.includes(0)) return { status: 'binary' };
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
