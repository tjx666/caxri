import type { DragEvent } from 'react';

import {
    isDirectoryDrag,
    PROJECT_PATH_DRAG_TYPE,
    terminalDragPaths,
    terminalInputPath,
} from '../../../lib/file-drag';
import { EDITOR_PATH_DRAG_TYPE } from '../../workbench/pane-drop-zone';

/**
 * A Files entry, Editor tab, or Project dropped into the composer: the composer writes `token` (the absolute path, with
 * a trailing `/` for a folder, shell-quoted only when it needs to be) into the draft and draws it as a pill with the
 * entry's icon and name.
 */
export interface AgentChatPathPill {
    kind: 'directory' | 'file';
    path: string;
    token: string;
}

/**
 * The pills a drop of Caxri's own Files entry, file reference, Editor tab, or Project drag cites, in drag order. Paths
 * stay absolute: the Agent reads them with its own tools from any directory, and an absolute path is what the pill's
 * icon and name stand for. Files from another application are not handled here; they become tray cards.
 */
export function agentChatDropPathPills(event: DragEvent): AgentChatPathPill[] {
    const { dataTransfer } = event;
    const projectPath = dataTransfer.getData(PROJECT_PATH_DRAG_TYPE);
    const editorPath = dataTransfer.getData(EDITOR_PATH_DRAG_TYPE);
    const references: Array<Omit<AgentChatPathPill, 'token'>> = projectPath
        ? [{ kind: 'directory', path: projectPath }]
        : editorPath
          ? [{ kind: 'file', path: editorPath }]
          : terminalDragPaths(event, []).map((path) => ({
                kind: isDirectoryDrag(dataTransfer) ? 'directory' : 'file',
                path,
            }));
    return references.map((reference) => ({
        ...reference,
        // A folder ends in `/`, so the sent message still draws it as a folder (`agentChatUserMessageSegments`).
        token: terminalInputPath(
            reference.kind === 'directory' && !reference.path.endsWith('/')
                ? `${reference.path}/`
                : reference.path,
        ),
    }));
}

/**
 * Where each known pill's token stands in `text` as a whole word (bounded by whitespace or the text's ends), in
 * document order and never overlapping, so a longer path that merely starts with a shorter one stays plain text.
 */
export function agentChatPathPillRanges(
    text: string,
    pills: ReadonlyMap<string, AgentChatPathPill>,
): Array<{ from: number; pill: AgentChatPathPill; to: number }> {
    const ranges: Array<{ from: number; pill: AgentChatPathPill; to: number }> = [];
    for (const pill of pills.values()) {
        let from = text.indexOf(pill.token);
        while (from !== -1) {
            const to = from + pill.token.length;
            if (isBoundary(text[from - 1]) && isBoundary(text[to])) ranges.push({ from, pill, to });
            from = text.indexOf(pill.token, from + 1);
        }
    }
    ranges.sort((a, b) => a.from - b.from || b.to - a.to);
    let end = -1;
    return ranges.filter((range) => {
        if (range.from < end) return false;
        end = range.to;
        return true;
    });
}

function isBoundary(character: string | undefined): boolean {
    return character === undefined || /\s/u.test(character);
}

/**
 * Whether a sent message's path lies inside the Session's Project root, the only place the Server may say whether it
 * names a folder (`files.resolveKind` rejects anything outside it).
 */
export function isPathInsideProject(path: string, projectRoot: string | undefined): boolean {
    if (!projectRoot) return false;
    const root = projectRoot.replace(/\/+$/u, '');
    return path === root || path.startsWith(`${root}/`);
}
