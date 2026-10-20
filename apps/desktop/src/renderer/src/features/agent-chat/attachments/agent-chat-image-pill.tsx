import { ImageIcon } from 'lucide-react';

import { useTranslation } from '../../../i18n';

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
        <span
            className="mx-px inline-flex h-4.5 items-center gap-1 rounded-sm bg-border/45 pr-1.5 pl-0.5 align-text-bottom text-[12px] leading-4.5 whitespace-nowrap"
            data-agent-chat-image-pill={number}
        >
            {thumbnail ? (
                <img alt="" className="size-3.5 rounded-xs object-cover" src={thumbnail} />
            ) : (
                <ImageIcon aria-hidden="true" className="size-3.5 text-muted" />
            )}
            {t('agentChat.attachments.imageNumber', { number })}
        </span>
    );
}
