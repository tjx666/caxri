import type { ReactNode } from 'react';
import { createContext } from 'react';

/**
 * Draws what a user message carried besides its text, such as an Agent Chat message's images. The Terminal timeline
 * provides none; the shared conversation list stays unaware of where attachments come from.
 */
export const ConversationUserAttachments = createContext<((itemId: string) => ReactNode) | null>(
    null,
);
