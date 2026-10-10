/**
 * The seam between the fake Claude Code CLI (`fake-claude-cli.ts`) and its scenario modules.
 */

type Json = Record<string, unknown>;

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
    result(startedAt: number, text: string): void;
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
}
