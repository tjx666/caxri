import { createContext } from 'react';

/**
 * A message the user long-pressed: its id, who wrote it, and the text the phone holds for it.
 */
export interface ConversationMessageTarget {
    id: string;
    role: 'agent' | 'user';
    text: string;
}

/**
 * Opens the actions of a long-pressed message (Copy Message, Select Text, and on a Chat "Edit from Here"). A list
 * without it leaves its messages without a long press; the shared Conversation renderer stays unaware of what each
 * surface offers.
 */
export const ConversationMessageActions = createContext<
    ((message: ConversationMessageTarget) => void) | null
>(null);
