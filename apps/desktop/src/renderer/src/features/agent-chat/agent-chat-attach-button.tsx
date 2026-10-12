import { useRef } from 'react';

import { Paperclip } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { agentChatAttachLabel } from './agent-chat-presentation';

/**
 * Opens the system file picker for any files. Chromium's file input is the native macOS open panel, and the picked
 * `File`s carry both their bytes (for an image attachment) and, through the preload, their path on disk (for a path
 * reference), so the picker takes the same route as a drop without a Main-side dialog method. The input stays hidden;
 * the button is what users see and focus. Its tooltip says what a pick does for this provider (`agentChatAttachLabel`):
 * images attach only when the provider takes them, and any other file becomes its path in the message. The accessible
 * name stays the action's short name.
 */
export function AgentChatAttachButton({
    canAttachImages,
    isBusy,
    onPick,
}: {
    /**
     * Whether the provider accepts images (`capabilities.chatImages`).
     */
    canAttachImages: boolean;
    /**
     * Picked images are still being read or a long paste is being saved, so the button shows progress.
     */
    isBusy: boolean;
    onPick: (files: File[]) => void;
}) {
    const { t } = useTranslation();
    const inputReference = useRef<HTMLInputElement>(null);
    return (
        <>
            <input
                aria-hidden
                className="hidden"
                multiple
                ref={inputReference}
                tabIndex={-1}
                type="file"
                onChange={(event) => {
                    onPick([...(event.target.files ?? [])]);
                    // Picking the same file again must fire `change` again.
                    event.target.value = '';
                }}
            />
            <Tooltip content={agentChatAttachLabel(canAttachImages, t)}>
                <Button
                    aria-label={t('agentChat.attachments.attachFiles')}
                    className="text-muted hover:text-foreground"
                    size="icon"
                    type="button"
                    variant="ghost"
                    onClick={() => inputReference.current?.click()}
                >
                    {isBusy ? <Spinner className="size-3.5" /> : <Paperclip className="size-4" />}
                </Button>
            </Tooltip>
        </>
    );
}
