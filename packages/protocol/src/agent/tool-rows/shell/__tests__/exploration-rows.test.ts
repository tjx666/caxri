import { describe, expect, it } from 'vitest';

import { describeAgentTool, summarizeAgentToolGroup } from '../../../agent-tool-presentation';

describe('shell exploration rows', () => {
    it('reads a path variable assigned earlier, and lists mixed explorations in order', () => {
        const describe = (summary: string) => describeAgentTool({ name: 'Bash', summary });
        const R = 'R=docs/references';
        expect(describe(`cd /work/app; ${R}; sed -n 15,50p $R/model.md`)).toMatchObject({
            kind: 'read',
            label: 'Read',
            path: 'docs/references/model.md',
        });
        expect(describe(`${R}; grep -n "x" "\${R}/model.md"`)).toMatchObject({
            kind: 'search',
            subject: 'x in model.md',
        });
        expect(
            describe(
                String.raw`cd /work/app; ${R}; sed -n 15,50p $R/model.md; sed -n 124,130p $R/model.md; grep -rn "Provider\b" src/chat.ts | head -3; echo ---; ls src 2>/dev/null`,
            ),
        ).toEqual({
            kind: 'read',
            label: 'Explored',
            subject: String.raw`model.md · Provider\b in chat.ts · src`,
            isCodeSubject: true,
        });
        // Single quotes keep `$R` literal.
        expect(describe(`${R}; grep -n '$R' a.md`)).toMatchObject({ subject: '$R in a.md' });
        // An unassigned or non-literal variable stays unreadable.
        for (const command of [
            'cat $HOME/a.md',
            'R=$(pwd); cat $R/a.md',
            'R="a b"; cat $R/a.md',
            `${R}`,
            'echo ---',
        ])
            expect(describe(command), command).toMatchObject({ kind: 'command', label: 'Ran' });
    });

    it('counts each step of an Explored command in the group summary', () => {
        expect(
            summarizeAgentToolGroup([
                { name: 'Bash', summary: 'cat a.ts b.ts; rg TODO src; ls src' },
                { name: 'Bash', summary: 'cat c.ts' },
            ]),
        ).toBe('Read 3 files, ran 1 search, listed 1 folder');
    });
});
