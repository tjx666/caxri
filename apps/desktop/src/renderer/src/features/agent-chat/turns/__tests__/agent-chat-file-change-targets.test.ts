import { gitFileDiffTabPath } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatChangeDiffTabPath,
    agentChatChangeFirstLine,
} from '../agent-chat-file-change-targets';

describe('agentChatChangeDiffTabPath', () => {
    const summary = {
        repositories: [
            {
                id: 'outer',
                rootPath: '/work/app',
                files: [{ path: 'src/a.ts' }, { path: 'vendor/lib/b.ts' }],
            },
            { id: 'inner', rootPath: '/work/app/vendor/lib/', files: [{ path: 'b.ts' }] },
        ],
    };

    it('opens the changed file in its innermost repository', () => {
        expect(agentChatChangeDiffTabPath(summary, '/work/app/src/a.ts')).toBe(
            gitFileDiffTabPath('outer', 'src/a.ts'),
        );
        expect(agentChatChangeDiffTabPath(summary, '/work/app/vendor/lib/b.ts')).toBe(
            gitFileDiffTabPath('inner', 'b.ts'),
        );
    });

    it('offers nothing for a file Git no longer reports as changed', () => {
        expect(agentChatChangeDiffTabPath(summary, '/work/app/src/clean.ts')).toBeUndefined();
        expect(agentChatChangeDiffTabPath(summary, '/work/application/src/a.ts')).toBeUndefined();
        expect(agentChatChangeDiffTabPath(undefined, '/work/app/src/a.ts')).toBeUndefined();
    });
});

describe('agentChatChangeFirstLine', () => {
    it('lands on the first added line', () => {
        expect(
            agentChatChangeFirstLine([
                { kind: 'hunk', text: '@@ -10,3 +10,4 @@' },
                { kind: 'context', text: 'a', oldLine: 10, newLine: 10 },
                { kind: 'added', text: 'b', newLine: 11 },
            ]),
        ).toBe(11);
    });

    it('falls back to the first hunk line, and to nothing for a pure deletion', () => {
        expect(
            agentChatChangeFirstLine([
                { kind: 'context', text: 'a', oldLine: 4, newLine: 4 },
                { kind: 'removed', text: 'b', oldLine: 5 },
            ]),
        ).toBe(4);
        expect(
            agentChatChangeFirstLine([{ kind: 'removed', text: 'b', oldLine: 1 }]),
        ).toBeUndefined();
    });
});
