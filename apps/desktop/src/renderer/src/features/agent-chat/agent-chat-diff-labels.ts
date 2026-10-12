import type { AgentChatEditedFile, AgentChatFileChange } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

/**
 * The change kind in words, for the accessible name the status letter alone does not give. The phone reads the English
 * `agentChatChangeKindLabel` in `@caxri/protocol`.
 */
export function agentChatLocalizedChangeKindLabel(
    kind: AgentChatFileChange['kind'],
    t: Translate = translate,
): string {
    return t(`agentChat.diff.kind.${kind}`);
}

/**
 * `Edited app.ts`, `Created app.ts`, `Deleted app.ts`, or `Edited 3 files`, the Codex app's turn summary title, in the
 * active language. The phone reads the English `agentChatEditedFilesTitle` in `@caxri/protocol`.
 */
export function agentChatLocalizedEditedFilesTitle(
    files: ReadonlyArray<Pick<AgentChatEditedFile, 'kind' | 'path'>>,
    t: Translate = translate,
): string {
    const only = files.at(0);
    if (!only || files.length !== 1)
        return t('agentChat.artifacts.editedFiles', { count: files.length });
    const name = pathBasename(only.path);
    if (only.kind === 'add') return t('agentChat.artifacts.createdFile', { name });
    if (only.kind === 'delete') return t('agentChat.artifacts.deletedFile', { name });
    return t('agentChat.artifacts.editedFile', { name });
}
