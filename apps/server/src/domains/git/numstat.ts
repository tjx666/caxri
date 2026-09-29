import type { GitFileStatus } from '@caxri/protocol';
import { mapWithConcurrency } from '@caxri/system';

import { untrackedLineCount } from './working-file-reads';

/**
 * The working tree's tracked diff against `HEAD`. It fails in an unborn repository, which then has no tracked counts.
 */
export const WORKING_TREE_NUMSTAT_ARGUMENTS = [
    'diff',
    '--numstat',
    '-z',
    '--no-renames',
    'HEAD',
    '--',
];

/**
 * New files whose lines one status snapshot counts. `git diff` cannot see them, so each is read from disk on every
 * snapshot; a generated tree that escaped `.gitignore` must not turn every edit into thousands of reads. Files past the
 * cap carry no line counts rather than a misleading zero.
 */
const MAX_NEW_FILES_LINE_COUNTED = 200;

/**
 * Largest new file whose lines are counted; a bigger one counts as zero rather than being read into memory.
 */
const MAX_NEW_FILE_LINE_COUNT_BYTES = 1024 * 1024;

/**
 * Files counted at once; the shared working-file read semaphore still bounds open descriptors process-wide.
 */
const MAX_CONCURRENT_NEW_FILE_COUNTS = 8;

export interface GitLineStat {
    additions: number;
    deletions: number;
}

/**
 * Parses Git's NUL-delimited `--numstat -z` output into per-path line counts, including the empty-path record Git emits
 * for a detected rename or copy (keyed by the new path). A binary file's `-\t-` record is skipped: Git has no line
 * count for it, and showing `+0 −0` would read as "unchanged".
 */
export function parseGitNumstat(output: string): Map<string, GitLineStat> {
    const result = new Map<string, GitLineStat>();
    const records = output.split('\0');
    for (let index = 0; index < records.length; index += 1) {
        // `[\s\S]` (rather than `.`) includes legal newlines embedded in a NUL-delimited Git filename.
        const fields = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/u.exec(records[index]);
        if (!fields) continue;
        const path = fields[3] || records[(index += 2)];
        if (!path || (fields[1] === '-' && fields[2] === '-')) continue;
        const previous = result.get(path);
        result.set(path, {
            additions: (previous?.additions ?? 0) + (fields[1] === '-' ? 0 : Number(fields[1])),
            deletions: (previous?.deletions ?? 0) + (fields[2] === '-' ? 0 : Number(fields[2])),
        });
    }
    return result;
}

export function sumGitLineStats(stats: Iterable<GitLineStat>): GitLineStat {
    let additions = 0;
    let deletions = 0;
    for (const stat of stats) {
        additions += stat.additions;
        deletions += stat.deletions;
    }
    return { additions, deletions };
}

/**
 * Attaches a file's line counts from a numstat map. A `--no-renames` diff reports a rename as the old path's deletion
 * plus the new path's addition, so the old path's deletions fold into the renamed entry.
 */
export function withGitLineStat<File extends Pick<GitFileStatus, 'path' | 'originalPath'>>(
    file: File,
    stats: ReadonlyMap<string, GitLineStat>,
): File & Partial<GitLineStat> {
    const current = stats.get(file.path);
    const original = file.originalPath ? stats.get(file.originalPath) : undefined;
    if (!current && !original) return file;
    return {
        ...file,
        additions: current?.additions ?? 0,
        deletions: (current?.deletions ?? 0) + (original?.deletions ?? 0),
    };
}

/**
 * Per-file line counts for the working-tree status snapshot, plus the repository totals of the tracked diff. A diff
 * against `HEAD` measures tracked files; an untracked file, or every file of an unborn repository (no `HEAD` to diff
 * against), is counted from disk instead, up to `MAX_NEW_FILES_LINE_COUNTED` files. The totals stay tracked-only so the
 * Status Bar and project status keep their existing meaning.
 */
export async function measureWorkingTreeLineStats(
    rootPath: string,
    files: readonly GitFileStatus[],
    numstat: string,
    head: string | undefined,
): Promise<{ files: GitFileStatus[] } & GitLineStat> {
    const hasHead = head !== undefined;
    const lineStats = parseGitNumstat(numstat);
    const newFiles = files
        .filter((file) => (file.kind === 'untracked' || !hasHead) && file.kind !== 'deleted')
        .slice(0, MAX_NEW_FILES_LINE_COUNTED);
    const newFileLines = new Map(
        await mapWithConcurrency(
            newFiles,
            MAX_CONCURRENT_NEW_FILE_COUNTS,
            async (file) =>
                [
                    file.path,
                    await untrackedLineCount(rootPath, file.path, MAX_NEW_FILE_LINE_COUNT_BYTES),
                ] as const,
        ),
    );
    return {
        files: files.map((file) => {
            const lines = newFileLines.get(file.path);
            if (lines !== undefined) return { ...file, additions: lines, deletions: 0 };
            return hasHead ? withGitLineStat(file, lineStats) : file;
        }),
        ...sumGitLineStats(lineStats.values()),
    };
}
