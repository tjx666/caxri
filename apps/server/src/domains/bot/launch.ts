import type { TerminalRecord } from '@caxri/protocol';

/**
 * Codex arguments that trust Caxri Bot's workspace for this launch only. Without them the first launch on a machine,
 * and on every new development profile, stops at Codex's folder-trust prompt inside Caxri Bot pane.
 *
 * The workspace is a Caxri-owned directory holding only generated instructions and Caxri Bot's own notes, so trusting
 * it grants what the user would grant by answering that prompt. Passing it as a `-c` override keeps it out of
 * `~/.codex/config.toml`: nothing is persisted, and profiles never accumulate trust entries there.
 *
 * Codex splits a `-c` key on every `.`, so a path cannot be a dotted key; an inline table carries it instead. It
 * replaces the `projects` table for this process only, which is harmless because Caxri Bot never leaves its workspace.
 * A JSON string literal is a valid TOML basic string for any path `realpath` returns. Verified against openai/codex
 * `rust-v0.159.0-alpha.9`: `codex-rs/config/src/overrides.rs` (override parsing) and
 * `codex-rs/tui/src/onboarding/directory_trust.rs` (the prompt is skipped for a trusted project).
 */
export function botTrustArguments(workspacePath: string): string[] {
    return ['-c', `projects={ ${JSON.stringify(workspacePath)} = { trust_level = "trusted" } }`];
}

/**
 * Codex reads at most `project_doc_max_bytes` of `AGENTS.md` (32 KiB by default) and silently drops the rest. The Caxri
 * Bot's generated `AGENTS.md` embeds its memory after the instructions, so the default would cut memory first; this
 * raises the limit above instructions plus `BOT_MEMORY_EMBED_BYTES` (`workspace.ts`).
 */
export const BOT_PROJECT_DOC_MAX_BYTES = 64 * 1024;

/**
 * Launch arguments that apply only to the recorded Caxri Bot Terminal, on a fresh launch, a restore, and a restart.
 */
export function botLaunchArguments(
    terminal: Pick<TerminalRecord, 'id' | 'kind'>,
    bot: { terminalId?: string; workspacePath?: string } | undefined,
): string[] {
    if (terminal.kind !== 'codex' || !bot?.workspacePath || bot.terminalId !== terminal.id)
        return [];
    return [
        ...botTrustArguments(bot.workspacePath),
        '-c',
        `project_doc_max_bytes=${BOT_PROJECT_DOC_MAX_BYTES}`,
    ];
}
