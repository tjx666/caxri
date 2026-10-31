import { z } from 'zod';

import { identifierSchema, pathSchema } from './identifiers.js';

/**
 * Upper bound on the condensed Markdown a reference file holds. A long Session keeps its most recent messages; the file
 * says how many earlier ones it left out so the Agent knows the record is partial.
 */
export const MAX_SESSION_CONVERSATION_REFERENCE_BYTES = 256 * 1024;

export const sessionConversationReferenceParametersSchema = z.object({
    sessionId: identifierSchema,
});

/**
 * Where the condensed conversation was written, and how much of it the file holds. The Renderer inserts `filePath` as
 * an `@` reference; it never receives the conversation text itself.
 */
export const sessionConversationReferenceResultSchema = z.object({
    filePath: pathSchema,
    title: z.string(),
    messageCount: z.number().int().nonnegative(),
    omittedMessageCount: z.number().int().nonnegative(),
});

export type SessionConversationReference = z.infer<typeof sessionConversationReferenceResultSchema>;

/**
 * One cited Session in a message or draft (`formatAgentChatSessionReference`): where its text starts and ends, the
 * reference file it names, and the Session title it was cited by.
 */
export interface AgentChatSessionReferenceRange {
    from: number;
    to: number;
    path: string;
    title: string;
}

/**
 * What lands in a Chat draft for a cited Project file: the `@` mention every Agent composer resolves, quoted when the
 * path holds whitespace, since an unquoted mention ends at the first space (the rule `formatAgentChatSessionReference`
 * follows).
 */
export function formatAgentChatFileMention(relativePath: string): string {
    return `@${/\s/u.test(relativePath) ? JSON.stringify(relativePath) : relativePath}`;
}

/**
 * Most Sessions an `@` search offers.
 */
const MAX_SESSION_REFERENCE_CANDIDATES = 20;

/**
 * How well `title` matches every query word: 0 for a title that starts with the query, 1 when each word starts a word
 * of the title, 2 for a plain substring match, `undefined` when some word is missing.
 */
function titleMatchTier(title: string, query: string): number | undefined {
    const normalizedTitle = title.toLowerCase();
    const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
    if (words.length === 0) return 0;
    if (words.some((word) => !normalizedTitle.includes(word))) return undefined;
    if (normalizedTitle.startsWith(words.join(' '))) return 0;
    const titleWords = normalizedTitle.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return words.every((word) => titleWords.some((titleWord) => titleWord.startsWith(word)))
        ? 1
        : 2;
}

/**
 * The Sessions an `@` can cite, searched by title, for Desktop and the phone alike: every unarchived Session with a
 * Primary Agent except the one doing the citing. An empty query lists the most recently opened first, which is the
 * Session a user most often means.
 */
export function searchSessionReferenceCandidates<
    S extends {
        archivedAt?: number;
        id: string;
        lastVisitedAt: number;
        primaryAgentTerminalId?: string;
        title: string;
    },
>(sessions: readonly S[] | undefined, currentSessionId: string | undefined, query: string): S[] {
    const ranked = (sessions ?? []).flatMap((session) => {
        if (
            session.id === currentSessionId ||
            session.archivedAt !== undefined ||
            !session.primaryAgentTerminalId
        )
            return [];
        const tier = titleMatchTier(session.title, query.trim());
        return tier === undefined ? [] : [{ session, tier }];
    });

    ranked.sort(
        (left, right) =>
            left.tier - right.tier ||
            right.session.lastVisitedAt - left.session.lastVisitedAt ||
            left.session.id.localeCompare(right.session.id),
    );
    return ranked.slice(0, MAX_SESSION_REFERENCE_CANDIDATES).map(({ session }) => session);
}

/**
 * The text a cited Session puts into a message, which is what the Agent receives: the `@` mention every Agent composer
 * resolves as a file, then one sentence saying what the file is so the Agent reads it as another conversation rather
 * than as project source. A path with whitespace is quoted, since an unquoted mention ends at the first space. Clients
 * show the whole span as one Session chip (`agentChatSessionReferenceRanges`), never this text.
 */
export function formatAgentChatSessionReference(
    reference: Pick<SessionConversationReference, 'filePath' | 'title'>,
): string {
    const path = /\s/u.test(reference.filePath)
        ? JSON.stringify(reference.filePath)
        : reference.filePath;
    return `@${path} contains the conversation from Session ${JSON.stringify(reference.title)}.`;
}

/**
 * `formatAgentChatSessionReference`'s output: a JSON-quoted or bare absolute path, then the sentence with the
 * JSON-quoted title. A JSON string body is any run of characters other than `"`, `\`, and a newline, or an escape.
 */
const SESSION_REFERENCE =
    /@(?:("(?:[^"\\\n]|\\.)+")|(\/\S+)) contains the conversation from Session ("(?:[^"\\\n]|\\.)*")\./gu;

function parseJsonString(text: string): string | undefined {
    try {
        const value: unknown = JSON.parse(text);
        return typeof value === 'string' ? value : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Every cited Session in `text`, in order and never overlapping. Clients match these before generic paths, so the
 * reference file inside a span never reads as a file pill of its own.
 */
export function agentChatSessionReferenceRanges(text: string): AgentChatSessionReferenceRange[] {
    const ranges: AgentChatSessionReferenceRange[] = [];
    for (const match of text.matchAll(SESSION_REFERENCE)) {
        // Exactly one path alternative matched; the other group is `undefined` at runtime despite its type.
        const [whole, quotedPath, barePath, quotedTitle] = match as unknown as [
            string,
            string | undefined,
            string | undefined,
            string,
        ];
        const path = quotedPath === undefined ? barePath : parseJsonString(quotedPath);
        const title = parseJsonString(quotedTitle);
        if (title !== undefined && path?.startsWith('/'))
            ranges.push({ from: match.index, to: match.index + whole.length, path, title });
    }
    return ranges;
}

/**
 * How a cited Session reads where a chip cannot show it (a queue row, the message rail, copied text): `@` and its
 * title.
 */
function agentChatSessionMention(title: string): string {
    return `@${title}`;
}

/**
 * `text` with each cited Session written as its mention (`agentChatSessionMention`) instead of the reference sentence.
 */
export function agentChatTextWithSessionMentions(text: string): string {
    let result = '';
    let offset = 0;
    for (const { from, title, to } of agentChatSessionReferenceRanges(text)) {
        result += text.slice(offset, from) + agentChatSessionMention(title);
        offset = to;
    }
    return result + text.slice(offset);
}
