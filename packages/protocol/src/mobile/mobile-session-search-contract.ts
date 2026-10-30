import { z } from 'zod';

import { agentProviderSchema } from '../agent/agents.js';
import { identifierSchema } from '../domain/identifiers.js';
import {
    sessionSearchIndexStatusSchema,
    sessionSearchMatchFieldSchema,
    sessionSearchRelaxationSchema,
} from '../domain/session-search.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * A reply must fit one sealed gateway frame (64 KiB of plaintext), so the phone gets fewer and shorter rows than
 * Desktop's search dialog: at the clipped lengths below, even a full page of CJK titles and snippets stays under
 * {@link MOBILE_SESSION_SEARCH_MAX_BYTES}.
 */
export const MOBILE_SESSION_SEARCH_MAX_RESULTS = 30;
export const MOBILE_SESSION_SEARCH_MAX_BYTES = 48 * 1_024;
export const MOBILE_SESSION_SEARCH_TITLE_MAX_LENGTH = 100;
export const MOBILE_SESSION_SEARCH_SNIPPET_MAX_LENGTH = 160;
export const MOBILE_SESSION_SEARCH_MAX_HIGHLIGHTS = 16;

/**
 * Which Sessions the phone searches: `caxri` keeps open and archived together, as on Desktop. External conversations
 * stay Desktop-only, since they belong to no Project a device can be granted.
 */
export const mobileSessionSearchStatusSchema = z.enum(['caxri', 'archived']);
export type MobileSessionSearchStatus = z.infer<typeof mobileSessionSearchStatusSchema>;

const offsetSchema = z.number().int().nonnegative();

const highlightSchema = z.tuple([offsetSchema, offsetSchema]);

const mobileSessionSearchSnippetSchema = z.strictObject({
    role: z.enum(['user', 'assistant']),
    text: z.string().max(MOBILE_SESSION_SEARCH_SNIPPET_MAX_LENGTH + 2),
    highlights: z.array(highlightSchema).max(MOBILE_SESSION_SEARCH_MAX_HIGHLIGHTS),
});

export const mobileSessionSearchEntrySchema = z.strictObject({
    sessionId: identifierSchema,
    projectId: identifierSchema,
    title: z.string().max(MOBILE_SESSION_SEARCH_TITLE_MAX_LENGTH),
    status: z.enum(['open', 'archived']),
    provider: agentProviderSchema.optional(),
    updatedAt: z.number().int().nonnegative(),
    match: z.strictObject({
        field: sessionSearchMatchFieldSchema,
        /**
         * The matching message, clipped around its first match. Highlights are UTF-16 `[start, end)` offsets into
         * `text`.
         */
        snippet: mobileSessionSearchSnippetSchema.optional(),
        messageCount: z.number().int().nonnegative().optional(),
    }),
});
export type MobileSessionSearchEntry = z.infer<typeof mobileSessionSearchEntrySchema>;

export const mobileSessionSearchResultSchema = z.strictObject({
    entries: z.array(mobileSessionSearchEntrySchema).max(MOBILE_SESSION_SEARCH_MAX_RESULTS),
    index: sessionSearchIndexStatusSchema,
    relaxation: sessionSearchRelaxationSchema,
});
export type MobileSessionSearchResult = z.infer<typeof mobileSessionSearchResultSchema>;

export const mobileSessionSearchMethods = {
    /**
     * Desktop's Session search over the Projects granted to the paired device: titles, IDs, folders, and message text
     * of its open and archived Sessions. An empty query lists the most recent ones.
     */
    'mobile.session.search': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({
            query: z.string().trim().max(200),
            status: mobileSessionSearchStatusSchema.default('caxri'),
            /**
             * The Project the list is filtered to; a ranking hint only, as on Desktop.
             */
            currentProjectId: identifierSchema.optional(),
        }),
        result: mobileSessionSearchResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;
