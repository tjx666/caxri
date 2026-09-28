import type { TerminalRecord } from '@caxri/protocol';

/**
 * Codex arguments that trust the Commander workspace for this launch only. Without them the first launch on a machine,
 * and on every new development profile, stops at Codex's folder-trust prompt inside the Commander pane.
 *
 * The workspace is a Caxri-owned directory holding only generated instructions and the Commander's own notes, so
 * trusting it grants what the user would grant by answering that prompt. Passing it as a `-c` override keeps it out of
 * `~/.codex/config.toml`: nothing is persisted, and profiles never accumulate trust entries there.
 *
 * Codex splits a `-c` key on every `.`, so a path cannot be a dotted key; an inline table carries it instead. It
 * replaces the `projects` table for this process only, which is harmless because the Commander never leaves its
 * workspace. A JSON string literal is a valid TOML basic string for any path `realpath` returns. Verified against
 * openai/codex `rust-v0.159.0-alpha.9`: `codex-rs/config/src/overrides.rs` (override parsing) and
 * `codex-rs/tui/src/onboarding/directory_trust.rs` (the prompt is skipped for a trusted project).
 */
export function commanderTrustArguments(workspacePath: string): string[] {
    return ['-c', `projects={ ${JSON.stringify(workspacePath)} = { trust_level = "trusted" } }`];
}

/**
 * Launch arguments that apply only to the recorded Commander Terminal, on a fresh launch, a restore, and a restart.
 */
export function commanderLaunchArguments(
    terminal: Pick<TerminalRecord, 'id' | 'kind'>,
    commander: { terminalId?: string; workspacePath?: string } | undefined,
): string[] {
    if (
        terminal.kind !== 'codex' ||
        !commander?.workspacePath ||
        commander.terminalId !== terminal.id
    )
        return [];
    return commanderTrustArguments(commander.workspacePath);
}
