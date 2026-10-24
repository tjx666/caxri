import type { DragEvent } from 'react';

import { isAgentChatVideoPath } from '@caxri/protocol';

import {
    isDirectoryDrag,
    isOsFileReferenceRefused,
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
 * icon and name stand for. Files from another application are not handled here: a video among them is cited inline too
 * (`agentChatOsVideoPills`), and the rest become tray cards.
 */
export function agentChatDropPathPills(event: DragEvent): AgentChatPathPill[] {
    const { dataTransfer } = event;
    const projectPath = dataTransfer.getData(PROJECT_PATH_DRAG_TYPE);
    const editorPath = dataTransfer.getData(EDITOR_PATH_DRAG_TYPE);
    const references: Array<Pick<AgentChatPathPill, 'kind' | 'path'>> = projectPath
        ? [{ kind: 'directory', path: projectPath }]
        : editorPath
          ? [{ kind: 'file', path: editorPath }]
          : terminalDragPaths(event, []).map((path) => ({
                kind: isDirectoryDrag(dataTransfer) ? 'directory' : 'file',
                path,
            }));
    return references.map(({ kind, path }) => agentChatPathPill(path, kind));
}

/**
 * The pill that cites `path` in the text: its token is the absolute path, with a trailing `/` for a folder,
 * shell-quoted only when it needs to be.
 */
export function agentChatPathPill(
    path: string,
    kind: AgentChatPathPill['kind'],
): AgentChatPathPill {
    return {
        kind,
        path,
        // A folder ends in `/`, so the sent message still draws it as a folder (`agentChatUserMessageSegments`).
        token: terminalInputPath(kind === 'directory' && !path.endsWith('/') ? `${path}/` : path),
    };
}

/**
 * The videos a message cites in its text, each once, in order of first mention; a sent message shows each as a playable
 * tile. A Chat on an SSH Host has none: its paths name files on that Host, which this Mac cannot play.
 */
export function agentChatMessageVideoPaths(text: string): string[] {
    if (isOsFileReferenceRefused()) return [];
    return [
        ...new Set(
            agentChatAbsolutePaths(text).flatMap(({ isDirectory, path }) =>
                !isDirectory && isAgentChatVideoPath(path) ? [path] : [],
            ),
        ),
    ];
}

/**
 * Whether a pill for `path` previews and plays it as a video (see `agentChatMessageVideoPaths`).
 */
export function isAgentChatPlayableVideo(path: string): boolean {
    return !isOsFileReferenceRefused() && isAgentChatVideoPath(path);
}

/**
 * A whole-word absolute path, as the composer writes a dropped Files entry, Editor tab, or Project (shell-quoted when
 * it holds a space; a folder ends in `/`). At least two segments, so a slash command such as `/btw` stays text; a path
 * with a line (`/repo/a.ts:12`) stays a file link.
 */
const ABSOLUTE_PATH = /(?<=^|\s)(?:'(\/[^'\n/]+\/[^'\n]*)'|(\/[^\s'"`/]+\/[^\s'"`]*))(?=$|\s)/gu;

/**
 * Every whole-word absolute path in `text` (see `ABSOLUTE_PATH`), in order: where it starts, the text it spans, the
 * path without quotes or a folder's trailing `/`, and whether it names a folder. A sent message draws each as a pill.
 */
export function agentChatAbsolutePaths(
    text: string,
): Array<{ index: number; isDirectory: boolean; path: string; text: string }> {
    return text
        .matchAll(ABSOLUTE_PATH)
        .flatMap((match) => {
            // Exactly one alternative matched; the other group is `undefined` at runtime despite its `string` type.
            const path = match[1] || match[2];
            if (/:\d+(?::\d+)?$/u.test(path)) return [];
            const isDirectory = path.endsWith('/');
            return [
                {
                    index: match.index,
                    isDirectory,
                    path: isDirectory ? path.replace(/\/+$/u, '') : path,
                    text: match[0],
                },
            ];
        })
        .toArray();
}

/**
 * The pills a draft restored into a new composer starts with: every whole-word absolute path in it, as a sent message
 * draws them. The draft outlives the composer (switching Sessions, the Terminal surface, or restarting Caxri) but the
 * record of which paths were dropped does not, so without this a restored drop reads as a raw path beside the pill of
 * the next one. A path the user typed into that draft becomes a pill too, as it does once sent; while the composer
 * stays mounted, a path typed into it turns into a pill only when dropped.
 */
export function agentChatDraftPathPills(draft: string): Map<string, AgentChatPathPill> {
    return new Map(
        agentChatAbsolutePaths(draft).map(({ isDirectory, path, text }) => [
            text,
            { kind: isDirectory ? 'directory' : 'file', path, token: text },
        ]),
    );
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
