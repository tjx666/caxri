import { describe, expect, it } from 'vitest';

import { interpolate } from '../../../../configuration/i18n-interpolate';
import type { AgentChatLabelTranslate } from '../../../agent-chat-labels';
import { agentChatLabelsZhCN } from '../../../agent-chat-labels-zh-cn';
import { describeAgentChatWork } from '../../../agent-chat-work';
import {
    agentToolActiveLabel,
    agentToolOutcomeLabel,
    describeAgentTool,
} from '../../../agent-tool-presentation';
import { agentToolLabel } from '../../agent-tool-labels';

const zh: AgentChatLabelTranslate = (key, parameters) =>
    interpolate(agentChatLabelsZhCN[key], parameters);

const row = (command: string) => {
    const { kind, label, subject } = describeAgentTool({ name: 'shell', summary: command });
    return { kind, label, subject };
};

describe('inline script rows', () => {
    it('names the language of a heredoc script instead of its code', () => {
        expect(row("cd /work/repo && python3 - <<'EOF'\nprint(1)\nEOF")).toEqual({
            kind: 'command',
            label: 'Ran Python script',
            subject: undefined,
        });
        expect(row("python3 -I - <<'PY'\nprint(1)\nPY").label).toBe('Ran Python script');
        expect(row("uv run --with rich python - <<'EOF'\nprint(1)\nEOF").label).toBe(
            'Ran Python script',
        );
        expect(row("node <<'JS'\nconsole.log(1)\nJS").label).toBe('Ran Node.js script');
        expect(row("bash <<'SH'\nls\nSH").label).toBe('Ran shell script');
    });

    it('names a script passed as one argument', () => {
        expect(row(`python3 -c "import json; print(json.load(open('a.json')))"`).label).toBe(
            'Ran Python script',
        );
        expect(row(`perl -0pi -e 's/a/b/g' src/app.ts`).label).toBe('Ran Perl script');
        expect(row(`bun -e 'console.log(1)'`).label).toBe('Ran Bun script');
    });

    it('keeps a shell -c wrapper and a script file as the command line', () => {
        expect(row(`zsh -i -c 'echo $PATH'`).label).toBe('Ran');
        expect(row('python3 tools/report.py --json').subject).toBe(
            'python3 tools/report.py --json',
        );
    });

    it('shows the comment a script opens with', () => {
        expect(row("python3 - <<'EOF'\n# Count rows per Session\nprint(1)\nEOF")).toEqual({
            kind: 'command',
            label: 'Ran Python script',
            subject: 'Count rows per Session',
        });
    });

    it('shows what runs after the script', () => {
        expect(row("python3 - <<'EOF'\nprint(1)\nEOF\nbun run check").subject).toBe(
            '→ bun run check',
        );
        expect(row(`python3 -c 'print(1)' && git diff --stat`).subject).toBe('→ git diff --stat');
        expect(row("python3 - <<'EOF' && echo ok\nprint(1)\nEOF\nls").subject).toBe('→ ls');
    });

    it('reads repeated scripts as one and drops progress echoes', () => {
        expect(
            row("python3 - <<'A'\nprint(1)\nA\npython3 - <<'B'\nprint(2)\nB\ncat types.ts").subject,
        ).toBe('→ cat types.ts');
        expect(row("python3 - <<'EOF'\nprint(1)\nEOF\necho done").subject).toBeUndefined();
    });

    it('reads in the reader language in every state', () => {
        const presentation = { kind: 'command' as const, label: 'Ran Python script' };
        expect(agentToolLabel('Ran Python script', zh)).toBe('已运行 Python 脚本');
        expect(agentToolActiveLabel(presentation, zh)).toBe('正在运行 Python 脚本');
        expect(agentToolOutcomeLabel(presentation, 'failed', zh)).toBe('无法运行 Python 脚本');
        expect(agentToolOutcomeLabel(presentation, 'interrupted', zh)).toBe(
            '已停止运行 Python 脚本',
        );
        expect(agentToolActiveLabel(presentation)).toBe('Running Python script');
    });

    it('lets the Agent description replace the subject', () => {
        const presentation = describeAgentChatWork({
            id: 'c1',
            type: 'command',
            command: "python3 - <<'EOF'\nprint(1)\nEOF\nbun run check",
            description: 'Rewrite the imports',
            status: 'completed',
        } as Parameters<typeof describeAgentChatWork>[0]);
        expect(presentation.label).toBe('Ran Python script');
        expect(presentation.subject).toBe('Rewrite the imports');
    });
});

describe('heredoc file writes', () => {
    it('reads as a write of that file', () => {
        expect(row("cat > a.md <<'EOF'\n# Title\nEOF")).toEqual({
            kind: 'write',
            label: 'Wrote',
            subject: 'a.md',
        });
        expect(row("cat >> /tmp/run/ledger.md <<'EOF'\nrow\nEOF").subject).toBe('ledger.md');
        expect(row('cat <<\'EOF\' > "notes/plan.md"\nx\nEOF').subject).toBe('plan.md');
        expect(row("tee -a out.log >/dev/null <<'EOF'\nx\nEOF").subject).toBe('out.log');
        expect(row("mkdir -p /tmp/run && cat > /tmp/run/seed.sql <<'EOF'\nx\nEOF").subject).toBe(
            'seed.sql',
        );
    });

    it('reads a file written for the next command as that command', () => {
        expect(
            row(
                "cat > /tmp/body.md <<'EOF'\nBody\nEOF\ngh issue create --title 'Fix login' --body-file /tmp/body.md",
            ),
        ).toMatchObject({ label: 'Opened issue', subject: 'Fix login' });
    });

    it('shows a command it cannot name after the file', () => {
        expect(row("cat >> a.md <<'EOF'\nx\nEOF\ntail -5 a.md | wc -l").subject).toBe(
            'a.md → tail -5 a.md | wc -l',
        );
    });
});

describe('heredoc command input', () => {
    it('reads a commit message passed as a heredoc', () => {
        expect(
            row("git add -A && git commit -q -F - <<'EOF'\nfix: keep titles short\n\nBody\nEOF"),
        ).toMatchObject({ label: 'Committed', subject: 'fix: keep titles short' });
        expect(
            row("git commit -F - <<'EOF'\nfix: x\nEOF\ngit push origin HEAD:refs/heads/fix-x"),
        ).toMatchObject({ label: 'Committed and pushed', subject: 'fix: x' });
    });
});
