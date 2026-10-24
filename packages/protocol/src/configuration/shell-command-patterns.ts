/**
 * Shell command patterns: the one syntax a setting uses to name shell commands, so every list of them (the long-running
 * background commands today, an approval or deny list later) reads and matches the same way.
 *
 * A pattern is matched against each sub-command of a command line (split at `&&`, `||`, `;`, `|`, and newlines), after
 * leading `NAME=value` assignments and wrappers such as `env`, `sudo`, `nohup`, and `timeout 60` are skipped. It takes
 * one of two forms:
 *
 * - **Text**: the sub-command must start with it and continue with whitespace or end there, so `bun run dev` matches `bun
 *   run dev --port 3000` but not `bun run devtools`. `*` stands for any run of characters, including spaces and slashes
 *   (`bun run *serve.ts`). The command's own name also matches without its directory, so `emulator` matches
 *   `~/Android/sdk/emulator/emulator -avd Pixel`. This is VS Code's `chat.tools.terminal.autoApprove` prefix rule with
 *   Claude Code's `Bash(...)` wildcard.
 * - **Regular expression**: `/source/flags`, tested against the same sub-command text, as VS Code's regex keys are.
 *
 * The matcher itself runs in Server Core and in the standalone hook bridge (`agents/hooks/shell-command-source.ts`);
 * this module owns the syntax every client validates.
 */

export const MAX_SHELL_COMMAND_PATTERNS = 64;
export const MAX_SHELL_COMMAND_PATTERN_LENGTH = 256;

const REGEX_PATTERN = /^\/(.+)\/([imsu]*)$/su;

/**
 * Canonicalizes one pattern as the user wrote it: trims surrounding whitespace and collapses inner runs of whitespace
 * in a text pattern (sub-commands are matched with single spaces). Returns `undefined` for an empty, oversized, or
 * NUL-carrying entry, and for a regular expression that does not compile. Only the `i`, `m`, `s`, and `u` flags make
 * `/source/flags` a regular expression; anything else reads as text.
 */
export function normalizeShellCommandPattern(input: string): string | undefined {
    const value = input.trim();
    if (!value || value.length > MAX_SHELL_COMMAND_PATTERN_LENGTH || value.includes('\0')) return;
    // An absolute command path (`/usr/bin/tail -f`) also starts with `/`; only `/source/flags` is a regular expression.
    const match = REGEX_PATTERN.exec(value);
    if (match) {
        try {
            new RegExp(match[1], match[2]);
        } catch {
            return;
        }
        return value;
    }
    return value.replaceAll(/\s+/gu, ' ');
}

/**
 * Background shells Claude Code starts that are expected to outlive the turn: development servers, log tails, and
 * emulators. A background shell that matches none of `agents.longRunningShellCommands` keeps the Session working until
 * it ends.
 */
export const DEFAULT_LONG_RUNNING_SHELL_COMMANDS: readonly string[] = [
    'npm run dev',
    'npm start',
    'pnpm dev',
    'pnpm run dev',
    'pnpm start',
    'yarn dev',
    'yarn start',
    'bun dev',
    'bun run dev',
    'bun start',
    'next dev',
    'vite',
    'tail -f',
    'tail -F',
    'emulator',
];
