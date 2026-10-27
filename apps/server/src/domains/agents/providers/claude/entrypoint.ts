/**
 * The `CLAUDE_CODE_ENTRYPOINT` every Claude process Caxri starts carries, written to each transcript record's
 * `entrypoint` field.
 *
 * Left unset, Claude Code labels an Agent SDK process `sdk-ts` and a `--print` run `sdk-cli`, and those labels drew
 * down the subscription's five-hour window about 1.7x faster than the interactive TUI for the same work, while a
 * client's own label metered like the TUI
 * (https://github.com/anthropics/claude-code/issues/97074#issuecomment-6426128541). The value is always overwritten: a
 * Server Core started from inside another Claude session inherits that session's label. T3 Code proposes the same label
 * for its Claude processes (https://github.com/pingdotgg/t3code/pull/25597).
 *
 * Claude Code sends the value as `cc_entrypoint` in every request's billing header and only maps the `sdk-*` labels to
 * its SDK client type (verified in the 2.1.310 binary); the Agent SDK fills in `sdk-ts` only when the variable is
 * unset.
 */
export const CAXRI_CLAUDE_ENTRYPOINT = 'caxri';

/**
 * Whether a transcript's first `entrypoint` marks a conversation an application started rather than one the user opened
 * in a terminal: Caxri's own label, or any Agent SDK and print-mode label.
 */
export function isHostedClaudeEntrypoint(entrypoint: string | undefined): boolean {
    return entrypoint === CAXRI_CLAUDE_ENTRYPOINT || entrypoint?.startsWith('sdk') === true;
}
