type Json = Record<string, unknown>;

/**
 * The suggestion the fake Claude Code CLI offers after a turn, so a test can tell it from any reply text.
 */
export const FAKE_CLAUDE_PROMPT_SUGGESTION = 'Run the fake tests again';

/**
 * The fake CLI's prompt suggestions, shaped like Claude Code's: offered only when `initialize` asked for them
 * (`promptSuggestions`), never after the first turn, and at most one per turn, right after a successful `result` that
 * ended the turn.
 */
export class FakeClaudePromptSuggestions {
    private isRequested = false;
    private finishedTurns = 0;

    onControl(request: Json): void {
        if (request.subtype === 'initialize') this.isRequested = request.promptSuggestions === true;
    }

    /**
     * The `prompt_suggestion` frame to send after a `result`, without the envelope fields `frame` adds.
     */
    afterResult(isError: boolean, queuedTurns: number): Json | undefined {
        if (isError || queuedTurns > 0) return undefined;
        this.finishedTurns++;
        if (!this.isRequested || this.finishedTurns === 1) return undefined;
        return { type: 'prompt_suggestion', suggestion: FAKE_CLAUDE_PROMPT_SUGGESTION };
    }
}
