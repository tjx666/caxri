import type { Translate } from '../../../i18n';
import { translate } from '../../../i18n';

/**
 * File rows a multi-file turn card lists before the rest fold behind a `Show N more files` row, as the Codex app's card
 * does, so a turn that touched many files does not push the Chat's next reply off screen.
 */
export const AGENT_CHAT_COLLAPSED_FILE_ROWS = 3;

/**
 * The rows a turn card lists and how many it folds away. Only a list longer than {@link AGENT_CHAT_COLLAPSED_FILE_ROWS}
 * folds; a collapsed list keeps its first rows in order.
 */
export function agentChatVisibleEditedFiles<T>(
    files: readonly T[],
    isListExpanded: boolean,
): { visible: readonly T[]; hiddenCount: number } {
    if (isListExpanded || files.length <= AGENT_CHAT_COLLAPSED_FILE_ROWS)
        return { visible: files, hiddenCount: 0 };
    return {
        visible: files.slice(0, AGENT_CHAT_COLLAPSED_FILE_ROWS),
        hiddenCount: files.length - AGENT_CHAT_COLLAPSED_FILE_ROWS,
    };
}

/**
 * `Show 2 more files` under a folded list, or `Show fewer files` once it is unfolded.
 */
export function agentChatLocalizedFileListToggle(
    hiddenCount: number,
    t: Translate = translate,
): string {
    if (hiddenCount === 0) return t('agentChat.changes.showFewerFiles');
    return t(
        hiddenCount === 1
            ? 'agentChat.changes.showMoreFilesOne'
            : 'agentChat.changes.showMoreFilesOther',
        { count: hiddenCount },
    );
}
