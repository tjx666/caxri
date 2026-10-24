import { describe, expect, it } from 'vitest';

import { appSettingsFileSchema } from '../settings-schema';
import {
    DEFAULT_LONG_RUNNING_SHELL_COMMANDS,
    MAX_SHELL_COMMAND_PATTERN_LENGTH,
    normalizeShellCommandPattern,
} from '../shell-command-patterns';

describe('normalizeShellCommandPattern', () => {
    it('trims and collapses whitespace in a text pattern', () => {
        expect(normalizeShellCommandPattern('  bun   run\tdev ')).toBe('bun run dev');
    });

    it('keeps a regular expression verbatim', () => {
        expect(normalizeShellCommandPattern('/^npm  run (dev|serve)$/i')).toBe(
            '/^npm  run (dev|serve)$/i',
        );
    });

    it('reads an absolute command path as text, not a regular expression', () => {
        expect(normalizeShellCommandPattern('/usr/bin/tail -f')).toBe('/usr/bin/tail -f');
    });

    it('rejects a regular expression that does not compile', () => {
        expect(normalizeShellCommandPattern('/(unclosed/')).toBeUndefined();
    });

    it('rejects an empty, NUL-carrying, or oversized pattern', () => {
        expect(normalizeShellCommandPattern(' '.repeat(3))).toBeUndefined();
        expect(normalizeShellCommandPattern('bun\0dev')).toBeUndefined();
        expect(
            normalizeShellCommandPattern('a'.repeat(MAX_SHELL_COMMAND_PATTERN_LENGTH + 1)),
        ).toBeUndefined();
    });
});

describe('agents.longRunningShellCommands', () => {
    it('defaults to the built-in development server list', () => {
        expect(appSettingsFileSchema.parse({})['agents.longRunningShellCommands']).toEqual(
            DEFAULT_LONG_RUNNING_SHELL_COMMANDS,
        );
    });

    it('keeps an explicitly empty list, which exempts no background shell', () => {
        expect(
            appSettingsFileSchema.parse({ 'agents.longRunningShellCommands': [] })[
                'agents.longRunningShellCommands'
            ],
        ).toEqual([]);
    });
});
