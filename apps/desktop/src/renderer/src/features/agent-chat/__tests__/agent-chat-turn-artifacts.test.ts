import type { AgentChatItem } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';
import { describe, expect, it } from 'vitest';

import {
    agentChatEditedFilesStat,
    agentChatEditedFilesTitle,
    collectAgentChatEditedFiles,
    collectAgentChatTurnArtifacts,
} from '../agent-chat-turn-artifacts';

const fileChange = (
    id: string,
    changes: Extract<AgentChatItem, { type: 'fileChange' }>['changes'],
    status: 'completed' | 'declined' = 'completed',
): AgentChatItem => ({ id, type: 'fileChange', status, changes });

describe('collectAgentChatEditedFiles', () => {
    it('merges edits to one path, drops declined ones and files created then deleted', () => {
        const files = collectAgentChatEditedFiles([
            fileChange('f1', [
                { path: '/p/a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-a\n+b' },
                { path: '/p/new.ts', kind: 'add', diff: 'x\ny\n' },
            ]),
            fileChange('f2', [{ path: '/p/a.ts', kind: 'update', diff: '@@ -1 +1,2 @@\n b\n+c' }]),
            fileChange(
                'f3',
                [{ path: '/p/skip.ts', kind: 'update', diff: '@@\n-a\n+b' }],
                'declined',
            ),
            fileChange('f4', [{ path: '/p/tmp.ts', kind: 'add', diff: 'z' }]),
            fileChange('f5', [{ path: '/p/tmp.ts', kind: 'delete', diff: 'z' }]),
        ]);
        expect(
            files.map(({ path, kind, additions, deletions }) => ({
                path,
                kind,
                additions,
                deletions,
            })),
        ).toEqual([
            { path: '/p/a.ts', kind: 'update', additions: 2, deletions: 1 },
            { path: '/p/new.ts', kind: 'add', additions: 2, deletions: 0 },
        ]);
        expect(agentChatEditedFilesStat(files)).toEqual({ additions: 4, deletions: 1 });
    });
});

describe('agentChatEditedFilesTitle', () => {
    it('names a single file by what happened to it and counts several', () => {
        expect(agentChatEditedFilesTitle([{ path: '/p/a.svg', kind: 'add' }], pathBasename)).toBe(
            'Created a.svg',
        );
        expect(
            agentChatEditedFilesTitle([{ path: '/p/a.svg', kind: 'update' }], pathBasename),
        ).toBe('Edited a.svg');
        expect(
            agentChatEditedFilesTitle(
                [
                    { path: '/p/a', kind: 'update' },
                    { path: '/p/b', kind: 'delete' },
                ],
                pathBasename,
            ),
        ).toBe('Edited 2 files');
    });
});

describe('collectAgentChatTurnArtifacts', () => {
    it('is undefined for a turn that changed and filed nothing', () => {
        expect(
            collectAgentChatTurnArtifacts('t1', [
                { id: 'r', type: 'agentMessage', text: 'hi', streaming: false },
            ]),
        ).toBeUndefined();
    });
});
