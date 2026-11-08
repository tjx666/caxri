import { useState } from 'react';

import type { AgentChatPathReference } from '@caxri/protocol';
import { agentChatMediaUrl } from '@caxri/protocol';
import { File, Folder } from 'lucide-react';

import { isOsFileReferenceRefused } from '../../../../lib/file-drag';
import { cn } from '../../../../lib/utilities';

/**
 * The picture Finder's icon view shows for a cited file or folder: QuickLook's thumbnail through Main's media scheme (a
 * document's first page, an audio file's note, a folder's icon), fitted inside the box and shadowed along its own
 * outline, so a page reads as a sheet and a folder icon keeps its shape. A path QuickLook cannot draw (a file since
 * deleted) falls back to the plain file or folder glyph, and so does every path in an SSH Host window, whose paths name
 * files on the remote machine (`isOsFileReferenceRefused`), as its videos do. Callers key it by path, so a new path
 * retries the thumbnail.
 */
export function AgentChatFileThumbnail({
    className,
    iconClassName,
    reference,
}: {
    /**
     * Sizes the box the thumbnail fits inside.
     */
    className: string;
    /**
     * Sizes the fallback glyph.
     */
    iconClassName: string;
    reference: AgentChatPathReference;
}) {
    const [hasFailed, setFailed] = useState(isOsFileReferenceRefused);
    const Icon = reference.isDirectory ? Folder : File;
    return (
        <span
            aria-hidden="true"
            className={cn('flex shrink-0 items-center justify-center text-muted', className)}
        >
            {hasFailed ? (
                <Icon className={iconClassName} />
            ) : (
                <img
                    alt=""
                    className="block max-h-full max-w-full object-contain drop-shadow-sm drop-shadow-shadow"
                    data-agent-chat-file-thumbnail={reference.path}
                    decoding="async"
                    draggable={false}
                    src={agentChatMediaUrl('thumbnail', reference.path)}
                    onError={() => setFailed(true)}
                />
            )}
        </span>
    );
}
