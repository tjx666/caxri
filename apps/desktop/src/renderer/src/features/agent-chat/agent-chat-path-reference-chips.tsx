import type { AgentChatPathReference } from '@caxri/protocol';
import { agentChatPathReferenceName } from '@caxri/protocol';
import { File, Folder } from 'lucide-react';

import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { openAgentChatPathReference } from './agent-chat-commands';

/**
 * The files and folders a sent message cites, as pills under its images. Clicking a folder opens it in Finder and
 * clicking a file shows it in its folder, as in the Codex app.
 */
export function AgentChatPathReferenceChips({
    references,
}: {
    references: readonly AgentChatPathReference[];
}) {
    const { t } = useTranslation();
    return (
        <ul
            aria-label={t('agentChat.pathReference.label')}
            className="m-0 flex max-w-[85%] list-none flex-wrap justify-end gap-1.5 p-0"
        >
            {references.map((reference) => {
                const Icon = reference.isDirectory ? Folder : File;
                const name = agentChatPathReferenceName(reference);
                const action = reference.isDirectory
                    ? 'agentChat.pathReference.openFolder'
                    : 'agentChat.pathReference.revealFile';
                return (
                    <li className="min-w-0" key={reference.path}>
                        <Tooltip content={t(action, { name: reference.path })}>
                            <button
                                aria-label={t(action, { name })}
                                className="flex h-7 max-w-60 min-w-0 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-elevated px-2.5 text-[12px] text-foreground transition-colors hover:border-muted focus-visible:outline focus-visible:outline-accent"
                                data-agent-chat-path-reference={reference.path}
                                type="button"
                                onClick={() => openAgentChatPathReference(reference.path)}
                            >
                                <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
                                <span className="truncate">{name}</span>
                            </button>
                        </Tooltip>
                    </li>
                );
            })}
        </ul>
    );
}
