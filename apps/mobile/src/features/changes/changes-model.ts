import type { Translate, TranslationKey } from '../../i18n';
import { translate } from '../../i18n';

type DiffLineKind = 'header' | 'hunk' | 'context' | 'added' | 'removed' | 'meta';

export interface DiffLine {
    id: string;
    kind: DiffLineKind;
    content: string;
    oldLine: number | null;
    newLine: number | null;
    marker: '+' | '−' | ' ';
}

export interface ParsedDiff {
    additions: number;
    deletions: number;
    lines: DiffLine[];
}

export interface ChangedFile {
    /**
     * Absent when Git has no line count for the file, such as a binary file.
     */
    additions?: number;
    deletions?: number;
    path: string;
    originalPath?: string;
    repositoryId: string;
    repositoryName: string;
    status: 'M' | 'A' | 'D' | 'R';
}

export interface ChangesSnapshot {
    additions: number;
    changedFileCount: number;
    deletions: number;
    files: ChangedFile[];
    isRepository: boolean;
    truncated: boolean;
}

export interface ChangesViewState {
    error: boolean;
    isLoading: boolean;
    isRefreshing: boolean;
    isStale: boolean;
    snapshot: ChangesSnapshot | null;
}

const changeStatusKey: Record<ChangedFile['status'], TranslationKey> = {
    M: 'changes.status.modified',
    A: 'changes.status.added',
    D: 'changes.status.deleted',
    R: 'changes.status.renamed',
};

const changeStatusLabel = (status: ChangedFile['status'], t: Translate = translate): string =>
    t(changeStatusKey[status]);

const hunkHeader = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Preserve the wire text while deriving line numbers and stats from unified diff hunks.
 */
export const parseUnifiedDiff = (diff: string): ParsedDiff => {
    const lines: DiffLine[] = [];
    let oldLine: number | null = null;
    let newLine: number | null = null;
    let additions = 0;
    let deletions = 0;
    const sourceLines = diff.endsWith('\n') ? diff.slice(0, -1).split('\n') : diff.split('\n');
    for (const content of sourceLines) {
        const id = String(lines.length);
        const hunk = hunkHeader.exec(content);
        if (hunk) {
            oldLine = Number(hunk[1]);
            newLine = Number(hunk[2]);
            lines.push({ id, kind: 'hunk', content, oldLine: null, newLine: null, marker: ' ' });
            continue;
        }
        if (oldLine === null || newLine === null) {
            lines.push({ id, kind: 'header', content, oldLine: null, newLine: null, marker: ' ' });
            continue;
        }
        if (content.startsWith('\\')) {
            lines.push({ id, kind: 'meta', content, oldLine: null, newLine: null, marker: ' ' });
        } else if (content.startsWith('+')) {
            lines.push({
                kind: 'added',
                id,
                content: content.slice(1),
                oldLine: null,
                newLine,
                marker: '+',
            });
            newLine += 1;
            additions += 1;
        } else if (content.startsWith('-')) {
            lines.push({
                kind: 'removed',
                id,
                content: content.slice(1),
                oldLine,
                newLine: null,
                marker: '−',
            });
            oldLine += 1;
            deletions += 1;
        } else if (content.startsWith(' ')) {
            lines.push({
                kind: 'context',
                id,
                content: content.slice(1),
                oldLine,
                newLine,
                marker: ' ',
            });
            oldLine += 1;
            newLine += 1;
        } else {
            lines.push({ id, kind: 'meta', content, oldLine: null, newLine: null, marker: ' ' });
        }
    }
    return { additions, deletions, lines };
};

/**
 * The `diff --git`, `index`, and `---`/`+++` preamble repeats the path the toolbar already shows and costs a phone
 * several rows. Keep it only when the patch has no hunk, where it is the whole message (binary or mode-only change).
 */
export const visibleDiffLines = (lines: readonly DiffLine[]): DiffLine[] =>
    lines.some((line) => line.kind === 'hunk')
        ? lines.filter((line) => line.kind !== 'header')
        : [...lines];

export const changePathParts = (path: string): { directory: string; filename: string } => {
    const slash = path.lastIndexOf('/');
    return slash === -1
        ? { directory: '', filename: path }
        : { directory: path.slice(0, slash + 1), filename: path.slice(slash + 1) };
};

export const hasMultipleRepositories = (files: ChangedFile[]): boolean =>
    new Set(files.map((file) => file.repositoryId)).size > 1;

export const changedFilesSummary = (count: number, t: Translate = translate): string =>
    t(count === 1 ? 'changes.filesChangedOne' : 'changes.filesChangedOther', { count });

/**
 * The summary in words with exact counts, for the screen reader; the visible summary uses compact counts.
 */
export const changesSummaryLabel = (
    count: number,
    additions: number,
    deletions: number,
    t: Translate = translate,
): string =>
    t('changes.summaryLabel', {
        added: t(additions === 1 ? 'changes.linesAddedOne' : 'changes.linesAddedOther', {
            count: additions,
        }),
        files: changedFilesSummary(count, t),
        removed: t('changes.linesRemoved', { count: deletions }),
    });

/**
 * The screen reader's description of one changed-file row: name, change kind, rename source, folder, repository, and
 * exact line counts.
 */
export const changedFileLabel = (file: ChangedFile, t: Translate = translate): string => {
    const { directory, filename } = changePathParts(file.path);
    const parameters = {
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
        directory: directory || t('changes.rootDirectory'),
        filename,
        repository: file.repositoryName,
        status: changeStatusLabel(file.status, t),
    };
    return file.originalPath
        ? t('changes.fileRowRenamedLabel', { ...parameters, originalPath: file.originalPath })
        : t('changes.fileRowLabel', parameters);
};
