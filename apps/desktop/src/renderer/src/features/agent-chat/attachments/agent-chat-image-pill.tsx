import { pathBasename } from '@caxri/utils';
import { ImageIcon } from 'lucide-react';

import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { resolveFileIcon } from '../../../icons/files/file-icon-resolver';

/**
 * The inline pills a sent message draws where the composer drew them while it was written.
 */
const PILL_CLASS_NAME =
    'mx-px inline-flex h-4.5 items-center gap-1 rounded-sm bg-border/45 pr-1.5 pl-0.5 align-text-bottom text-[12px] leading-4.5 whitespace-nowrap';

/**
 * An image's `[Image #N]` placeholder in a sent message, drawn as the pill the composer showed while it was written:
 * the image's thumbnail and its name. A message read back from history may have no thumbnail; the pill then shows an
 * image icon. The tiles above the bubble preview the image, so the pill only marks where it sits in the text.
 */
export function AgentChatImagePill({
    number,
    thumbnail,
}: {
    number: number;
    thumbnail: string | undefined;
}) {
    const { t } = useTranslation();
    return (
        <span className={PILL_CLASS_NAME} data-agent-chat-image-pill={number}>
            {thumbnail ? (
                <img alt="" className="size-3.5 rounded-xs object-cover" src={thumbnail} />
            ) : (
                <ImageIcon aria-hidden="true" className="size-3.5 text-muted" />
            )}
            {t('agentChat.attachments.imageNumber', { number })}
        </span>
    );
}

/**
 * An absolute path in a sent message, drawn as the pill the composer showed while it was written: the entry's file-type
 * icon and name, with the full path on hover. When the Chat can open files the pill opens it; it is an anchor so a pill
 * at the end of a line wraps with the text around it, as the file links beside it do.
 */
export function AgentChatPathPill({
    isDirectory,
    onOpen,
    path,
}: {
    isDirectory: boolean;
    onOpen: ((path: string) => void) | undefined;
    path: string;
}) {
    const name = pathBasename(path) || path;
    const content = (
        <>
            <img
                alt=""
                className="size-3.5 shrink-0"
                src={resolveFileIcon({ kind: isDirectory ? 'directory' : 'file', name }).src}
            />
            {name}
        </>
    );
    return (
        <Tooltip content={path}>
            {onOpen ? (
                <a
                    className={`${PILL_CLASS_NAME} cursor-pointer text-foreground no-underline hover:bg-border/75 focus-visible:outline focus-visible:outline-accent`}
                    data-agent-chat-path-pill={path}
                    href={path}
                    onClick={(event) => {
                        // Main denies every window navigation; `href` only makes the pill focusable and Enter-activated.
                        event.preventDefault();
                        onOpen(path);
                    }}
                >
                    {content}
                </a>
            ) : (
                <span className={PILL_CLASS_NAME} data-agent-chat-path-pill={path}>
                    {content}
                </span>
            )}
        </Tooltip>
    );
}
