import { createContext } from 'react';

/**
 * Opens a file a message cites (`src/a.ts:12`, a `[a.ts](/repo/a.ts)` link, a user message's file chip) in the file
 * viewer. A surface without a Session to read from (the Caxri Bot inbox) leaves it unset, so its paths stay text.
 */
export const ConversationFileOpener = createContext<((reference: string) => void) | null>(null);
