/**
 * A reply's body size and paragraph spacing (the Markdown library's own paragraph margin). Shared so a host that folds
 * the Markdown to whole lines, such as the question card, measures with the same numbers `ConversationMarkdown` draws.
 */
export const CONVERSATION_MARKDOWN = {
    body: { fontSize: 15, lineHeight: 23 },
    paragraph: { marginBottom: 10, marginTop: 10 },
} as const;

/**
 * The secondary size of a transcript record, matching the 13px text around it.
 */
export const CONVERSATION_MARKDOWN_COMPACT = {
    body: { fontSize: 13, lineHeight: 18 },
    paragraph: { marginBottom: 4, marginTop: 4 },
} as const;
