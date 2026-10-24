import { DEFAULT_LONG_RUNNING_SHELL_COMMANDS } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { shellCommandMatchesAny } from '../shell-command-source';
import { commandCreatesWorktree } from '../worktree-command';

describe('shellCommandMatchesAny', () => {
    it.each([
        ['a pattern prefix that ends at whitespace', 'bun run dev --port 3000', ['bun run dev']],
        ['the whole command', 'bun run dev', ['bun run dev']],
        ['a later sub-command', 'cd web && bun run dev', ['bun run dev']],
        ['a piped sub-command', 'tail -f server.log | grep error', ['tail -f']],
        [
            'a command after environment assignments',
            'PORT=3000 NODE_ENV=dev bun run dev',
            ['bun run dev'],
        ],
        [
            'a command under wrappers',
            'nohup env DEBUG=1 timeout -s KILL 2h bun run dev',
            ['bun run dev'],
        ],
        ['a command by its basename', '~/Android/sdk/emulator/emulator -avd Pixel', ['emulator']],
        ['a quoted argument', 'bun run "dev"', ['bun run dev']],
        [
            'a wildcard',
            'bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts dev',
            ['bun run *switch-worktree.ts dev'],
        ],
        ['a regular expression', 'pnpm --filter web serve', [String.raw`/^pnpm .*\bserve\b/`]],
        ['a case-insensitive regular expression', 'NEXT dev', ['/^next dev/i']],
    ])('matches %s', (_label, command, patterns) => {
        expect(shellCommandMatchesAny(command, patterns)).toBe(true);
    });

    it.each([
        ['a longer word', 'bun run devtools', ['bun run dev']],
        ['an argument that only mentions the pattern', 'echo bun run dev', ['bun run dev']],
        ['a regular expression special character in text', 'bun run dev', ['bun run d.v']],
        ['an empty pattern list', 'bun run dev', []],
        ['an empty command', '', ['bun run dev']],
        ['a non-string command', undefined, ['bun run dev']],
        ['an oversized command', `bun run dev ${'x'.repeat(40_000)}`, ['bun run dev']],
        ['an invalid regular expression', 'bun run dev', ['/(/']],
    ])('does not match %s', (_label, command, patterns) => {
        expect(shellCommandMatchesAny(command, patterns)).toBe(false);
    });

    it.each(DEFAULT_LONG_RUNNING_SHELL_COMMANDS)('compiles the default pattern %s', (pattern) => {
        expect(shellCommandMatchesAny(`${pattern} --verbose`, [pattern])).toBe(true);
    });

    it('still classifies worktree creation through the shared parser', () => {
        expect(commandCreatesWorktree('nohup git -C repo worktree add ../feature')).toBe(true);
        expect(commandCreatesWorktree('git worktree list')).toBe(false);
    });
});
