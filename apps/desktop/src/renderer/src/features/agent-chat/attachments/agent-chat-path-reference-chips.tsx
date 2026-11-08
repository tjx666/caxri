import type { AgentChatPathReference } from '@caxri/protocol';
import { agentChatPathReferenceName } from '@caxri/protocol';

import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { openAgentChatPathReference } from '../agent-chat-commands';
import { AgentChatFileThumbnail } from './file-thumbnail/agent-chat-file-thumbnail';
import { agentChatFileTileName } from './file-thumbnail/agent-chat-file-tile-name';

/**
 * The files and folders a sent message cites, as tiles above its bubble laid out like Finder's icon view: the QuickLook
 * thumbnail (a PDF's first page, a folder's icon) over the name, shortened in the middle so the extension always shows
 * (`agentChatFileTileName`); nothing when it cites none. The skills it asked for show inside the bubble instead
 * (`AgentChatSkillPill`). Clicking a folder opens it in Finder and clicking a file shows it in its folder, as in the
 * Codex app; the full path is on hover.
 */
export function AgentChatPathReferenceChips({
    references,
}: {
    references: readonly AgentChatPathReference[];
}) {
    const { t } = useTranslation();
    if (references.length === 0) return null;
    return (
        <ul
            aria-label={t('agentChat.pathReference.label')}
            className="m-0 flex max-w-[85%] list-none flex-wrap justify-end gap-1 p-0"
        >
            {references.map((reference) => {
                const name = agentChatPathReferenceName(reference);
                const action = reference.isDirectory
                    ? 'agentChat.pathReference.openFolder'
                    : 'agentChat.pathReference.revealFile';
                return (
                    <li key={reference.path}>
                        <Tooltip content={t(action, { name: reference.path })}>
                            <button
                                aria-label={t(action, { name })}
                                className="flex w-26 cursor-pointer flex-col items-center gap-1.5 rounded-md border-0 bg-transparent px-0.5 pt-2 pb-1.5 text-foreground transition-colors hover:bg-elevated focus-visible:outline focus-visible:outline-accent"
                                data-agent-chat-path-reference={reference.path}
                                type="button"
                                onClick={() => openAgentChatPathReference(reference.path)}
                            >
                                <AgentChatFileThumbnail
                                    className="size-16"
                                    iconClassName="size-8"
                                    key={reference.path}
                                    reference={reference}
                                />
                                <span className="line-clamp-2 w-full text-center text-[12px] leading-4 wrap-anywhere">
                                    {agentChatFileTileName(name)}
                                </span>
                            </button>
                        </Tooltip>
                    </li>
                );
            })}
        </ul>
    );
}
