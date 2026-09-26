export interface VisibleTranscriptMessage {
    role: 'assistant' | 'user';
    text: string;
    isChunk: boolean;
}

/**
 * Markers that open an injected instruction envelope rather than something the user or the Agent wrote.
 */
const INJECTED_BLOCK_PATTERN =
    /^(?:# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<system-reminder>|<INSTRUCTIONS>|<user_instructions>|<user-prompt-submit-hook>|<local-command|<command-name>|<command-message>)/u;

const INJECTED_MARKER_PATTERN =
    /# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<system-reminder>|<INSTRUCTIONS>|<user_instructions>|<user-prompt-submit-hook>|<local-command|<command-name>|<command-message>/u;

/**
 * Tool input and output are separate provider blocks, but may carry the same injected envelopes as messages.
 */
export function stripInjectedTranscriptContent(text: string): string {
    if (INJECTED_BLOCK_PATTERN.test(text.trimStart())) return '';
    const marker = INJECTED_MARKER_PATTERN.exec(text);
    return marker ? text.slice(0, marker.index).trimEnd() : text;
}

/**
 * Drops injected envelopes one content block at a time. Providers append an envelope as a sibling block beside genuine
 * text, so testing the joined message only caught an envelope that happened to lead it and let a trailing one through.
 * Session content search returns this text to the Renderer verbatim as a match snippet, so a leaked block is
 * user-visible. Blocks are tested leading-whitespace-insensitively but retained unmodified, because Grok streaming
 * chunks are coalesced by the caller and must keep their own spacing.
 */
function visibleBlockText(blocks: string[]): string {
    return blocks.map(stripInjectedTranscriptContent).filter(Boolean).join('\n');
}

interface ParsedTranscriptMessage {
    content: unknown;
    isGrokChunk: boolean;
    role: string;
}

/**
 * Shared entry parsing for every provider's message record shape (Claude Code JSONL messages, Codex response_item
 * messages, and Grok ACP session/update chunks). Returns the role and raw, un-stripped content so a caller can choose
 * whether to strip injected envelopes (`extractVisibleTranscriptMessage`) or pattern-match them directly
 * (`extractRawUserTranscriptText`, used only to classify a system event before stripping would erase the evidence).
 */
function parseTranscriptMessage(record: unknown): ParsedTranscriptMessage | undefined {
    if (!record || typeof record !== 'object') return;
    const entry = record as {
        method?: string;
        params?: { update?: { sessionUpdate?: string; content?: unknown } };
        type?: string;
        payload?: { type?: string; role?: string; content?: unknown };
        message?: { content?: unknown };
        isMeta?: boolean;
        isSidechain?: boolean;
    };
    if (entry.isMeta || entry.isSidechain) return;
    const update = entry.method === 'session/update' ? entry.params?.update : undefined;
    const isGrokChunk =
        update?.sessionUpdate === 'user_message_chunk' ||
        update?.sessionUpdate === 'agent_message_chunk';
    const message = isGrokChunk
        ? {
              role: update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant',
              content: [update.content],
          }
        : entry.type === 'response_item' && entry.payload?.type === 'message'
          ? { role: entry.payload.role, content: entry.payload.content }
          : { role: entry.type, content: entry.message?.content };
    if (message.role !== 'user' && message.role !== 'assistant') return;
    return { content: message.content, isGrokChunk, role: message.role };
}

function contentBlocks(content: unknown): string[] {
    return typeof content === 'string'
        ? [content]
        : Array.isArray(content)
          ? content.flatMap((part: unknown) => {
                if (!part || typeof part !== 'object') return [];
                const block = part as { type?: string; text?: unknown };
                return ['text', 'input_text', 'output_text'].includes(block.type ?? '') &&
                    typeof block.text === 'string'
                    ? [block.text]
                    : [];
            })
          : [];
}

/**
 * Shared visible-message boundary for title generation and Session search. Tool bodies, sidechains and injected
 * instructions are excluded before callers truncate or combine text. No transcript data belongs in diagnostics.
 */
export function extractVisibleTranscriptMessage(
    record: unknown,
): VisibleTranscriptMessage | undefined {
    const parsed = parseTranscriptMessage(record);
    if (!parsed) return;
    const rawText = visibleBlockText(contentBlocks(parsed.content));
    const text = parsed.isGrokChunk ? rawText : rawText.trim();
    if (!text) return;
    return { role: parsed.role as 'user' | 'assistant', text, isChunk: parsed.isGrokChunk };
}

/**
 * Raw, envelope-preserving text for a user-turn transcript record. Used only by timeline projection to classify a
 * harness-injected system event (slash-command echo, bash-mode echo, task notification) before
 * `extractVisibleTranscriptMessage` strips those same envelopes away; never exposed outside timeline projection.
 */
export function extractRawUserTranscriptText(record: unknown): string | undefined {
    const parsed = parseTranscriptMessage(record);
    if (parsed?.role !== 'user') return;
    const raw = contentBlocks(parsed.content).join('\n').trim();
    return raw || undefined;
}
