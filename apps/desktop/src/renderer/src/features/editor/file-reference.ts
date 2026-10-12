import type { PaneLayout, TerminalRecord } from '@caxri/protocol';
import { projectRelativePath, visiblePaneTerminalIds } from '@caxri/protocol';

export interface FileReferenceInput {
    /**
     * Absolute POSIX path of the referenced file.
     */
    path: string;
    /**
     * Root of the Project the editor is scoped to; paths outside it fall back to the absolute form.
     */
    projectRoot: string | undefined;
    /**
     * 1-based inclusive line span. A collapsed cursor passes the same line twice.
     */
    startLine: number;
    endLine: number;
}

/**
 * Formats the `@path#L12` / `@path#L12-L20` mention that agent CLIs accept and that Caxri's own Terminal link parser
 * (`parseTerminalFileLocation`) navigates back to the editor, so the two directions stay round-trippable. A trailing
 * space lets the user keep typing the rest of the prompt immediately.
 */
export function formatFileReference({
    path,
    projectRoot,
    startLine,
    endLine,
}: FileReferenceInput): string {
    const relativePath = projectRoot ? projectRelativePath(path, projectRoot) : undefined;
    const target = relativePath && relativePath !== '.' ? relativePath : path;
    const range = endLine > startLine ? `#L${startLine}-L${endLine}` : `#L${startLine}`;
    return `@${target}${range} `;
}

/**
 * Picks the Terminal a reference should be typed into when the editor, not a Terminal, owns the active tab: prefer a
 * Terminal the user can currently see, and among candidates the most recently opened one. Mirrors the "most recently
 * opened Terminal" convention of editor-to-terminal send commands rather than inventing a focus history for Terminals.
 */
export function chooseReferenceTerminal(
    terminals: readonly TerminalRecord[],
    sessionId: string,
    layout: PaneLayout | undefined,
): TerminalRecord | undefined {
    const sessionTerminals = terminals.filter((terminal) => terminal.sessionId === sessionId);
    const visible = new Set(layout ? visiblePaneTerminalIds(layout) : []);
    const newestFirst = (candidates: readonly TerminalRecord[]): TerminalRecord | undefined =>
        candidates
            .toSorted((a, b) => b.createdAt - a.createdAt || b.orderIndex - a.orderIndex)
            .at(0);
    return (
        newestFirst(sessionTerminals.filter((terminal) => visible.has(terminal.id))) ??
        newestFirst(sessionTerminals)
    );
}
