import type { ReactNode } from 'react';

import type { AgentChatPathReference } from '@caxri/protocol';
import { agentChatPathReferenceName } from '@caxri/protocol';
import { File, Folder, X } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';

/**
 * The round Remove button on an attachment's top-right corner, shared by image thumbnails and file or folder cards.
 */
export function AgentChatAttachmentRemoveButton({
    className,
    label,
    onRemove,
}: {
    className?: string;
    label: string;
    onRemove: () => void;
}): ReactNode {
    return (
        <Button
            aria-label={label}
            className={cn('absolute size-5 rounded-full shadow-sm', className)}
            size="icon"
            type="button"
            variant="secondary"
            onClick={onRemove}
        >
            <X className="size-3" />
        </Button>
    );
}

/**
 * A file or folder attached to the message being written, as the Codex app shows one: an icon tile, the name, and
 * whether it is a folder or a file, with the full path on hover. The message cites it by path when sent.
 */
export function AgentChatPathAttachmentCard({
    reference,
    removeLabel,
    onRemove,
}: {
    reference: AgentChatPathReference;
    removeLabel: string;
    onRemove: () => void;
}) {
    const { t } = useTranslation();
    const Icon = reference.isDirectory ? Folder : File;
    return (
        <li className="relative" data-agent-chat-path-attachment={reference.path}>
            <Tooltip content={reference.path}>
                <div className="flex h-14 max-w-60 min-w-0 items-center gap-2.5 rounded-lg border border-border bg-elevated pr-4 pl-2">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-background text-foreground">
                        <Icon aria-hidden="true" className="size-5" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                        <span className="truncate text-[13px] leading-5 font-medium text-foreground">
                            {agentChatPathReferenceName(reference)}
                        </span>
                        <span className="text-[12px] leading-4 text-muted">
                            {t(
                                reference.isDirectory
                                    ? 'agentChat.attachments.folder'
                                    : 'agentChat.attachments.file',
                            )}
                        </span>
                    </span>
                </div>
            </Tooltip>
            <AgentChatAttachmentRemoveButton
                className="-top-1.5 -right-1.5"
                label={removeLabel}
                onRemove={onRemove}
            />
        </li>
    );
}
