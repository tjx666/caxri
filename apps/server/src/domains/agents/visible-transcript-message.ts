export interface VisibleTranscriptMessage {
    role: 'assistant' | 'user';
    text: string;
    isChunk: boolean;
}

/**
 * Shared visible-message boundary for title generation and Session search. Tool bodies, sidechains and injected
 * instructions are excluded before callers truncate or combine text. No transcript data belongs in diagnostics.
 */
export function extractVisibleTranscriptMessage(
    record: unknown,
): VisibleTranscriptMessage | undefined {
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
    const rawText =
        typeof message.content === 'string'
            ? message.content
            : Array.isArray(message.content)
              ? message.content
                    .flatMap((part: unknown) => {
                        if (!part || typeof part !== 'object') return [];
                        const block = part as { type?: string; text?: unknown };
                        return ['text', 'input_text', 'output_text'].includes(block.type ?? '') &&
                            typeof block.text === 'string'
                            ? [block.text]
                            : [];
                    })
                    .join('\n')
              : '';
    const text = isGrokChunk ? rawText : rawText.trim();
    if (
        !text ||
        /^(?:# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<system-reminder>|<INSTRUCTIONS>|<local-command|<command-name>|<command-message>)/u.test(
            text,
        )
    )
        return;
    return { role: message.role, text, isChunk: isGrokChunk };
}
