import { describe, expect, it } from 'vitest';

import { readableShellCommand, unwrapShellCommand } from '../agent-shell-title';

describe('unwrapShellCommand', () => {
    it('returns the script a login shell ran', () => {
        expect(unwrapShellCommand(String.raw`/bin/zsh -lc "rg -n \"a|b\" src"`)).toBe(
            'rg -n "a|b" src',
        );
        expect(unwrapShellCommand(`bash -c 'ls -la'`)).toBe('ls -la');
        expect(unwrapShellCommand('git status')).toBe('git status');
    });
});

describe('readableShellCommand', () => {
    it('drops output plumbing from every command in a chain', () => {
        expect(
            readableShellCommand(
                'npm view @scope/cli version 2>&1 | tail -1; tool --help 2>&1 | head -30; which tool 2>/dev/null',
            ),
        ).toBe('npm view @scope/cli version; tool --help; which tool');
    });
    it('keeps a filter that changes what the command shows', () => {
        expect(readableShellCommand("gh api repos/a/b | sed -n '/^## Install/,$p'")).toBe(
            "gh api repos/a/b | sed -n '/^## Install/,$p'",
        );
        expect(readableShellCommand('git log | head -n 5 | wc -l')).toBe(
            'git log | head -n 5 | wc -l',
        );
    });
    it('drops setup statements that only prepare the command after them', () => {
        expect(
            readableShellCommand(
                'cd /work/repo-worktrees/shared && git commit -q -a --fixup=abc1234 && git push',
            ),
        ).toBe('git commit -q -a --fixup=abc1234 && git push');
        expect(
            readableShellCommand(
                `cd /tmp/acc; S=acc1; A="agent-browser --session $S"; $A click @e25; sleep 2; $A snapshot`,
            ),
        ).toBe(
            'agent-browser --session $S click @e25; sleep 2; agent-browser --session $S snapshot',
        );
        expect(
            readableShellCommand(
                String.raw`cd ~/Library/Application\ Support/App; sqlite3 -readonly app.db ".tables"`,
            ),
        ).toBe('sqlite3 -readonly app.db ".tables"');
        expect(readableShellCommand('R=/tmp/run; ls $R/assets; ${R}/bin/tool')).toBe(
            'ls $R/assets; /tmp/run/bin/tool',
        );
        expect(
            readableShellCommand('export CI=1 FORCE=1 && sleep 20; . /tmp/lib.sh; gh pr checks 14'),
        ).toBe('gh pr checks 14');
        expect(readableShellCommand("cd 'dir with space'\nbun run check")).toBe('bun run check');
    });
    it('keeps a setup statement that is the whole command or only an environment prefix', () => {
        expect(readableShellCommand('cd src')).toBe('cd src');
        expect(readableShellCommand('cd src;')).toBe('cd src;');
        expect(readableShellCommand('CI=1 bun run test')).toBe('CI=1 bun run test');
    });
    it('names a heredoc by the line that opens it, not its body', () => {
        expect(
            readableShellCommand(
                "cd /work/repo && python3 - <<'EOF'\np='packages/a.ts'\ns=open(p).read()\nEOF\nbun run check",
            ),
        ).toBe("python3 - <<'EOF'\nbun run check");
        expect(readableShellCommand('cat > notes.md <<-MD\n# Notes\n\tMD')).toBe(
            'cat > notes.md <<-MD',
        );
        expect(
            readableShellCommand(
                `git commit -m "$(cat <<'EOF'\nfix: keep titles short\n\nBody\nEOF\n)" && git push`,
            ),
        ).toBe(`git commit -m 'fix: keep titles short' && git push`);
        expect(readableShellCommand("python3 - <<'EOF'\nprint(1)")).toBe(
            "python3 - <<'EOF'\nprint(1)",
        );
    });
});
