/**
 * The seam between the fake Claude Code CLI (`fake-claude-cli.ts`) and its scenario modules.
 */

type Json = Record<string, unknown>;

/**
 * The `usage` object of an assistant frame: tokens read from the cache, written to it, and sent fresh, plus the reply.
 */
export interface FakeClaudeUsage {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}

/**
 * What the scenario modules beside `fake-claude-cli.ts` need from the CLI process that hosts them.
 */
export interface FakeClaudeIo {
    send(message: Json): void;
    /**
     * Appends an entry to the session transcript.
     */
    record(entry: Json): void;
    frame(entry: Json): Json;
    system(subtype: string, fields?: Json): void;
    assistant(messageId: string, block: Json): void;
    toolResult(toolUseId: string, content: string): void;
    result(startedAt: number, text: string, isError?: boolean): void;
    /**
     * Sets the usage later assistant and result frames carry, and the context size `get_context_usage` reports, until
     * the next call. A process that never calls it reports the fixed defaults.
     */
    setUsage(usage: FakeClaudeUsage): void;
    didStreamFully(text: string, chunkDelayMs: number): Promise<boolean>;
    /**
     * Sends a control request to the SDK and resolves with its response.
     */
    controlRequest(request: Json): Promise<Json>;
    isInterrupted(): boolean;
    /**
     * Records that the SDK interrupted the turn, as a denied approval with `interrupt: true` does.
     */
    markInterrupted(): void;
    /**
     * Where Claude Code writes this session's subagent transcripts.
     */
    subagentDirectory: string;
    /**
     * Starts a turn without a user message, as Claude Code does when a background task finishes.
     */
    startAutoTurn(): void;
    /**
     * Leaves plan mode after an approved plan, as Claude Code does, reporting the mode it returned to: the `setMode`
     * update the approval carried, else `default`.
     */
    exitPlanMode(mode?: string): void;
}

export interface QueuedTurn {
    text: string;
    /**
     * The SDK message uuid, which the real CLI reuses as the transcript record uuid.
     */
    uuid?: string;
    content: unknown;
    priority?: unknown;
    /**
     * A turn the CLI starts on its own, such as after a background task finished.
     */
    isAuto?: boolean;
}

function userText(message: unknown): string {
    if (!message || typeof message !== 'object') return '';
    const { content } = message as { content?: unknown };
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((block) =>
            block && typeof block === 'object' && 'text' in block
                ? String((block as { text: unknown }).text)
                : '',
        )
        .join('');
}

/**
 * The turn an SDK `user` message on stdin asks for.
 */
export function queuedTurn(message: Json): QueuedTurn {
    return {
        text: userText(message.message),
        content: (message.message as { content?: unknown } | undefined)?.content,
        priority: message.priority,
        ...(typeof message.uuid === 'string' && { uuid: message.uuid }),
    };
}
