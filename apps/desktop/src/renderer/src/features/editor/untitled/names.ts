import { parseUntitledEditorTab } from '@caxri/protocol';
import type { EditorDocument } from '@desktop-shared/editor-state';

import type { Translate } from '../../../i18n';
import { translate } from '../../../i18n';

/**
 * How much of the first line VS Code reads for an untitled buffer's name, and how long the name may be.
 */
const FIRST_LINE_CANDIDATE_MAX_LENGTH = 400;
const FIRST_LINE_NAME_MAX_LENGTH = 40;

/**
 * The lowest `N` no open untitled buffer uses, so closing `Untitled-1` lets the next new buffer take it again, as in VS
 * Code.
 */
export function nextUntitledIndex(paths: Iterable<string>): number {
    const used = new Set<number>();
    for (const path of paths) {
        const index = parseUntitledEditorTab(path);
        if (index !== undefined) used.add(index);
    }
    let index = 1;
    while (used.has(index)) index += 1;
    return index;
}

/**
 * The tab name VS Code derives from an untitled buffer's first line: whitespace collapsed, at most 40 characters, and
 * only when the line has a letter or digit to show. `undefined` keeps the `Untitled-N` name.
 */
export function untitledFirstLineName(content: string): string | undefined {
    const candidate = content.slice(0, FIRST_LINE_CANDIDATE_MAX_LENGTH);
    const newline = candidate.search(/\r?\n/);
    const firstLine = (newline === -1 ? candidate : candidate.slice(0, newline))
        .trim()
        .replaceAll(/\s+/g, ' ');
    if (!/[\p{L}\p{N}]/u.test(firstLine)) return undefined;
    return [...firstLine].slice(0, FIRST_LINE_NAME_MAX_LENGTH).join('').trimEnd();
}

/**
 * Characters macOS and the other desktop platforms refuse or treat specially in a file name.
 */
const UNSAFE_FILE_NAME_CHARACTERS = /[/\\:*?"<>|]/g;

/**
 * The name Save As suggests: the first-line name (or `Untitled-N`) with the detected language's extension, the way VS
 * Code suggests `hello world.py` for a Python buffer starting with `hello world`.
 */
export function untitledSuggestedFileName(
    displayName: string,
    languageExtension: string | undefined,
): string {
    const base =
        displayName.replaceAll(UNSAFE_FILE_NAME_CHARACTERS, ' ').replaceAll(/\s+/g, ' ').trim() ||
        'Untitled';
    const extension = languageExtension ? `.${languageExtension}` : '';
    return base.toLowerCase().endsWith(extension.toLowerCase()) ? base : `${base}${extension}`;
}

/**
 * The name an untitled buffer goes by in its tab, prompts, and Save As: its first line, or `Untitled-N`.
 */
export function untitledDisplayName(
    path: string,
    content: string,
    t: Translate = translate,
): string {
    return (
        untitledFirstLineName(content) ??
        t('editor.tab.untitled', { index: parseUntitledEditorTab(path) ?? 1 })
    );
}

/**
 * An empty untitled buffer. It is clean until it holds text, and its zero modification time and size are what an
 * on-device backup of it recorded, so a backup from an earlier launch always restores into it.
 */
export function emptyUntitledDocument(path: string): EditorDocument {
    return { path, content: '', mtimeMs: 0, size: 0, dirty: false, ephemeral: true };
}
