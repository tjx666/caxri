import { z } from 'zod';

import { agentProviderSchema } from '../agent/agents.js';
import { identifierSchema, pathSchema } from './identifiers.js';

/**
 * Upper bound on the conversations one Session search returns, best match first.
 */
export const MAX_SESSION_SEARCH_RESULTS = 100;

/**
 * Inline Markdown markers a rendered message hides: code spans and fences, bold, underline emphasis, strikethrough.
 */
const INLINE_MARKDOWN_PATTERN = /`+|\*\*|__|~~/gu;

/**
 * Drops the inline Markdown markers rendering hides, so a sentence copied from a rendered Agent Chat message matches
 * the Markdown source it came from. The Server applies it to indexed text and queries; the Renderer applies it to the
 * query it hands to find in the opened Chat, which searches rendered text.
 */
export function normalizeSessionSearchText(text: string): string {
    return text.replaceAll(INLINE_MARKDOWN_PATTERN, '');
}

/**
 * Collapses every run of whitespace (spaces, tabs, newlines, paragraph breaks, no-break spaces) into one space and
 * trims the ends. A sentence copied across rendered paragraphs carries line breaks the query box and the Chat find bar
 * hold as single spaces, so the result row, the handoff, and find all compare text through this one rule.
 */
export function normalizeSessionSearchWhitespace(text: string): string {
    return text.replaceAll(/\s+/gu, ' ').trim();
}

/**
 * The filter operators a query may carry. Used by the Server to parse them and by the Renderer to remove one when its
 * chip is dismissed, so both read the same syntax. Matches `name:value` or `name:"value with spaces"` at the start of
 * the query or after whitespace; a colon inside a word ("http://", "error:42") never starts an operator because only
 * the four names qualify. Global: use it only with `replaceAll`, never with `exec` or `test`.
 */
export const SESSION_SEARCH_OPERATOR_PATTERN =
    /(^|\s)(agent|project|before|after):(?:"([^"]*)"|(\S+))/giu;

/**
 * Where a found conversation lives: an open Session, an archived Session, or only in an Agent CLI's own history on this
 * machine (started outside Caxri, or left behind by a Session that was deleted).
 */
const sessionSearchStatuses = ['open', 'archived', 'external'] as const;
const sessionSearchStatusSchema = z.enum(sessionSearchStatuses);
export type SessionSearchStatus = z.infer<typeof sessionSearchStatusSchema>;

/**
 * `caxri` keeps open and archived Sessions together: everything Caxri already holds.
 */
export const sessionSearchStatusFilters = ['all', 'caxri', 'archived', 'external'] as const;
const sessionSearchStatusFilterSchema = z.enum(sessionSearchStatusFilters);
export type SessionSearchStatusFilter = z.infer<typeof sessionSearchStatusFilterSchema>;

export const sessionSearchParametersSchema = z.object({
    /**
     * Whitespace-separated terms that must all match. Empty lists the most recent conversations.
     */
    query: z.string().trim().max(200),
    /**
     * Restricts results to these Agent providers; absent or empty means every provider.
     */
    providers: z.array(agentProviderSchema).max(16).optional(),
    status: sessionSearchStatusFilterSchema.optional(),
    /**
     * The Project the user is working in. A ranking hint only: results whose folder lies inside that Project's root
     * sort ahead of otherwise equal ones, and nothing is dropped.
     */
    currentProjectId: identifierSchema.optional(),
});
export type SessionSearchParameters = z.infer<typeof sessionSearchParametersSchema>;

/**
 * Which field made the conversation a result. `recent` marks an empty query's listing.
 */
const sessionSearchMatchFields = ['recent', 'id', 'title', 'path', 'content'] as const;
const sessionSearchMatchFieldSchema = z.enum(sessionSearchMatchFields);
export type SessionSearchMatchField = z.infer<typeof sessionSearchMatchFieldSchema>;

/**
 * A short excerpt of one matching user or Agent message, with the matched ranges as UTF-16 `[start, end)` offsets.
 */
const snippetOffsetSchema = z.number().int().nonnegative();

const sessionSearchSnippetSchema = z.object({
    role: z.enum(['user', 'assistant']),
    text: z.string().max(400),
    highlights: z.array(z.tuple([snippetOffsetSchema, snippetOffsetSchema])).max(32),
});
export type SessionSearchSnippet = z.infer<typeof sessionSearchSnippetSchema>;

const sessionSearchBranchSchema = z.object({
    /**
     * Stable row identity: `<provider>:<conversation id>`, or `session:<Session id>` for a Session without an Agent
     * conversation.
     */
    key: z.string().min(1).max(512),
    title: z.string().max(1_024),
    status: sessionSearchStatusSchema,
    /**
     * The Caxri Session that holds the conversation; absent for an `external` one.
     */
    sessionId: identifierSchema.optional(),
    projectId: identifierSchema.optional(),
    provider: agentProviderSchema.optional(),
    /**
     * The provider's own conversation ID: what its resume argument takes.
     */
    agentSessionId: z.string().max(1_024).optional(),
    /**
     * The folder the conversation ran in. An `external` conversation without one cannot be added to Caxri.
     */
    cwd: pathSchema.optional(),
    updatedAt: z.number().int().nonnegative(),
    /**
     * Set when the request named a `currentProjectId` and this conversation belongs to that Project (a Session in it,
     * or an external conversation whose folder lies inside its root), so a client that re-sorts results can keep them
     * first.
     */
    isCurrentProject: z.literal(true).optional(),
    match: z.object({
        field: sessionSearchMatchFieldSchema,
        snippet: sessionSearchSnippetSchema.optional(),
        /**
         * Matching messages in the conversation; only for a `content` match.
         */
        messageCount: z.number().int().nonnegative().optional(),
    }),
    /**
     * Messages in the conversation's transcript; only set on the members of a fork group, so a branch list can show how
     * far each branch went.
     */
    totalMessages: z.number().int().nonnegative().optional(),
});

const sessionSearchEntrySchema = sessionSearchBranchSchema.extend({
    /**
     * Set when this result stands for several branches of one conversation (Claude `--fork-session`, Codex and Grok
     * forks, which all copy the earlier messages into a new conversation ID). The entry is the most recently active
     * branch; this lists every matching branch, that one included, newest first.
     */
    branches: z.array(sessionSearchBranchSchema).min(2).max(MAX_SESSION_SEARCH_RESULTS).optional(),
});
export type SessionSearchEntry = z.infer<typeof sessionSearchEntrySchema>;

/**
 * The background index's progress: `indexing` while transcripts changed since the last pass are still being read, so
 * results may be missing their newest messages; `unavailable` when the index could not be opened at all, in which case
 * only Caxri's own Session titles are searched.
 */
const sessionSearchIndexStatusSchema = z.object({
    state: z.enum(['indexing', 'ready', 'unavailable']),
    conversations: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
});
export type SessionSearchIndexStatus = z.infer<typeof sessionSearchIndexStatusSchema>;

/**
 * How far the Server loosened the query to find results, from strictest to loosest: `phrase` is the query as typed
 * (every word, with a message holding them as one phrase when there is one); `allWords` found no phrase, so results
 * hold every word apart; `anyWord` found none holding every word, so results hold at least one.
 */
const sessionSearchRelaxations = ['phrase', 'allWords', 'anyWord'] as const;
const sessionSearchRelaxationSchema = z.enum(sessionSearchRelaxations);
export type SessionSearchRelaxation = z.infer<typeof sessionSearchRelaxationSchema>;

/**
 * The filter operators the Server parsed out of the query (`agent:`, `project:`, `before:`, `after:`), so the dialog
 * can show them as removable chips. Dates are local calendar days (`YYYY-MM-DD`): `before` excludes that day and
 * `after` includes it.
 */
const sessionSearchFiltersSchema = z.object({
    agents: z.array(agentProviderSchema).max(16),
    projects: z.array(z.string().max(200)).max(8),
    before: z.string().max(10).optional(),
    after: z.string().max(10).optional(),
});
export type SessionSearchFilters = z.infer<typeof sessionSearchFiltersSchema>;

export const sessionSearchResultSchema = z.object({
    entries: z.array(sessionSearchEntrySchema).max(MAX_SESSION_SEARCH_RESULTS),
    index: sessionSearchIndexStatusSchema,
    /**
     * A term shorter than three characters cannot use the full-text index, so message text was scanned instead.
     */
    usedSubstringScan: z.boolean(),
    filters: sessionSearchFiltersSchema,
    relaxation: sessionSearchRelaxationSchema,
});
export type SessionSearchResult = z.infer<typeof sessionSearchResultSchema>;

/**
 * Messages shown on each side of the previewed match.
 */
export const SESSION_SEARCH_PREVIEW_CONTEXT_MESSAGES = 2;
/**
 * Upper bound on one previewed message's text, in UTF-16 code units; a longer message is cut around its first match.
 */
export const MAX_SESSION_SEARCH_PREVIEW_MESSAGE_CHARACTERS = 1_200;

export const sessionSearchPreviewParametersSchema = z.object({
    provider: agentProviderSchema,
    agentSessionId: z.string().trim().min(1).max(1_024),
    /**
     * The query whose matches the preview centers on and highlights. Empty (or matching no message) previews the end of
     * the conversation.
     */
    query: z.string().trim().max(200),
    /**
     * Which matching message to center on, oldest first; wraps past the last one. Defaults to the newest, the one a
     * result row quotes.
     */
    matchIndex: z.number().int().nonnegative().max(100_000).optional(),
});
export type SessionSearchPreviewParameters = z.infer<typeof sessionSearchPreviewParametersSchema>;

const sessionSearchPreviewMessageSchema = z.object({
    role: z.enum(['user', 'assistant']),
    text: z.string().max(MAX_SESSION_SEARCH_PREVIEW_MESSAGE_CHARACTERS + 2),
    highlights: z.array(z.tuple([snippetOffsetSchema, snippetOffsetSchema])).max(64),
    /**
     * The message the preview centers on.
     */
    isMatch: z.boolean(),
});
export type SessionSearchPreviewMessage = z.infer<typeof sessionSearchPreviewMessageSchema>;

export const sessionSearchPreviewResultSchema = z.object({
    /**
     * The centered message with up to two before and two after, oldest first. Empty when the index holds no messages
     * for the conversation (a Shell-only Session, or one whose Agent has not written yet).
     */
    messages: z
        .array(sessionSearchPreviewMessageSchema)
        .max(2 * SESSION_SEARCH_PREVIEW_CONTEXT_MESSAGES + 1),
    /**
     * Messages in the conversation that hold every query term.
     */
    matchCount: z.number().int().nonnegative(),
    /**
     * The shown match's position among them; 0 when there is none.
     */
    matchIndex: z.number().int().nonnegative(),
    hasEarlier: z.boolean(),
    hasLater: z.boolean(),
});
export type SessionSearchPreviewResult = z.infer<typeof sessionSearchPreviewResultSchema>;

export const sessionImportConversationParametersSchema = z.object({
    provider: agentProviderSchema,
    agentSessionId: z.string().trim().min(1).max(1_024),
});

export const sessionImportConversationResultSchema = z.object({
    sessionId: identifierSchema,
    projectId: identifierSchema,
});
export type SessionImportConversationResult = z.infer<typeof sessionImportConversationResultSchema>;
