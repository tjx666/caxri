import { createContext, use } from 'react';

/**
 * Tells the timeline the reader is opening or closing one of its rows (a tool group, a turn's changes, a folded turn).
 * Expanding a row is the reader reading, not the conversation moving, so the list stops following its end and the
 * tapped row stays where it was, as Desktop's Agent Chat anchors a clicked disclosure (`anchor` in the Desktop
 * Renderer's `use-agent-chat-scroll.ts`). Following on slid the tapped row away, and the rows below it first dropped by
 * the expanded height and then jumped back up, which read as the timeline flashing mid-stream.
 */
export const ConversationDisclosure = createContext<() => void>(() => {});

/**
 * Wraps a row's disclosure toggle so the timeline holds its place before the row grows or shrinks.
 */
export const useConversationDisclosure = (): (() => void) => use(ConversationDisclosure);
