import { useRef } from 'react';

import { ImagePlus } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { AGENT_CHAT_IMAGE_ACCEPT } from './agent-chat-images';

/**
 * Opens the system file picker for images. The native input stays hidden; the button is what users see and focus.
 */
export function AgentChatAttachButton({
    isReading,
    onPick,
}: {
    /**
     * Picked images are still being read, so the button shows progress.
     */
    isReading: boolean;
    onPick: (files: File[]) => void;
}) {
    const inputReference = useRef<HTMLInputElement>(null);
    return (
        <>
            <input
                accept={AGENT_CHAT_IMAGE_ACCEPT}
                aria-hidden
                className="hidden"
                multiple
                ref={inputReference}
                tabIndex={-1}
                type="file"
                onChange={(event) => {
                    onPick([...(event.target.files ?? [])]);
                    event.target.value = '';
                }}
            />
            <Tooltip content="Attach images">
                <Button
                    aria-label="Attach images"
                    size="icon"
                    variant="ghost"
                    onClick={() => inputReference.current?.click()}
                >
                    {isReading ? (
                        <Spinner className="size-3.5" />
                    ) : (
                        <ImagePlus className="size-4" />
                    )}
                </Button>
            </Tooltip>
        </>
    );
}
