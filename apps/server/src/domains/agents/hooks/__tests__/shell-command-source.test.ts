import { DEFAULT_LONG_RUNNING_SHELL_COMMANDS } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { shellCommandMatchesAny } from '../shell-command-source';
import { commandCreatesWorktree, commandWorktreeAddPath } from '../worktree-command';

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

    it.each([
        ['an absolute path', 'git worktree add /wt/feature', undefined, '/wt/feature'],
        [
            'the production command shape',
            "git -C '/Users/me/repo' worktree add -b fix/topic '/Users/me/repo-worktrees/fix-topic' origin/main",
            undefined,
            '/Users/me/repo-worktrees/fix-topic',
        ],
        [
            'a trailing slash and dot segments',
            'git worktree add /wt/./a/../feature/',
            undefined,
            '/wt/feature',
        ],
        [
            'a relative path against the known cwd',
            'git worktree add ../wt/feature',
            '/Users/me/repo',
            '/Users/me/wt/feature',
        ],
        [
            'a relative path against an absolute -C',
            'git -C /Users/me/repo worktree add ../wt',
            undefined,
            '/Users/me/wt',
        ],
        [
            'a relative -C against the cwd',
            'git -C repo worktree add ../wt',
            '/Users/me',
            '/Users/me/wt',
        ],
        [
            'options before the path',
            'git worktree add -f --detach --no-checkout --lock --reason why /wt/a HEAD',
            undefined,
            '/wt/a',
        ],
        [
            'boolean flags',
            'git worktree add --orphan -q --track --guess-remote /wt/a',
            undefined,
            '/wt/a',
        ],
        ['an attached value', 'git worktree add --reason=why /wt/a', undefined, '/wt/a'],
        ['a clustered -fb', 'git worktree add -fb topic /wt/a', undefined, '/wt/a'],
        ['an end-of-options marker', 'git worktree add -b topic -- /wt/a', undefined, '/wt/a'],
        [
            'a shell -c layer',
            `/bin/zsh -lc "git worktree add -b x '/wt/a b'"`,
            undefined,
            '/wt/a b',
        ],
        [
            'a path after an unrelated segment',
            'echo hi && git worktree add /wt/a',
            undefined,
            '/wt/a',
        ],
    ])('extracts the worktree path from %s', (_label, command, cwd, expected) => {
        expect(commandCreatesWorktree(command)).toBe(true);
        expect(commandWorktreeAddPath(command, cwd)).toBe(expected);
    });

    it.each([
        ['a relative path with no known cwd', 'git worktree add ../wt', undefined],
        ['a relative cwd', 'git worktree add ../wt', 'relative'],
        ['a relative path after cd', 'cd /elsewhere && git worktree add ../wt', '/Users/me/repo'],
        [
            'a relative path inside a shell after cd',
            `bash -c "cd /x && git worktree add wt"`,
            '/Users/me',
        ],
        ['a shell variable', 'git worktree add "$HOME/wt"', '/Users/me'],
        ['a home shorthand', 'git worktree add ~/wt', '/Users/me'],
        ['a glob', 'git worktree add /wt/*', undefined],
        ['an explicit --git-dir', 'git --git-dir=/x/.git worktree add ../wt', '/Users/me'],
        ['no operand', 'git worktree add', '/Users/me'],
        ['the filesystem root', 'git worktree add /', undefined],
        ['a path past the bound', `git worktree add /${'a'.repeat(1_100)}`, undefined],
        ['not a worktree add', 'git worktree list /wt/a', undefined],
    ])('yields no worktree path for %s', (_label, command, cwd) => {
        expect(commandWorktreeAddPath(command, cwd)).toBeUndefined();
    });

    it.each([
        [
            'Codex double-quoted login shell',
            '/bin/zsh -lc "git worktree add ../feature -b feature"',
            true,
        ],
        ['single-quoted script', "bash -c 'cd repo && git -C . worktree add ../feature'", true],
        ['a script that only lists worktrees', '/bin/zsh -lc "git worktree list"', false],
        ['a shell running a script file', 'bash scripts/worktree.sh', false],
        ['a second nested shell layer', `zsh -lc "bash -c 'git worktree add ../feature'"`, false],
    ])('classifies worktree creation inside %s', (_label, command, expected) => {
        expect(commandCreatesWorktree(command)).toBe(expected);
    });
});
