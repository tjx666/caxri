import type { AgentChatWorkItem, AppLocale } from '@caxri/protocol';
import {
    agentChatActivity,
    agentChatApprovalChoices,
    agentChatChangeKindLabel,
    agentChatEditedFilesTitle,
    agentChatItemStatusLabel,
    agentChatRequestTitle,
    agentChatTurnLabel,
    agentChatWaitingText,
    describeAgentChatWork,
    emptyAgentChatSnapshot,
    summarizeAgentChatWork,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate, useLocaleStore } from '../../../i18n';
import {
    agentChatLocalizedFileListToggle,
    agentChatVisibleEditedFiles,
} from '../agent-chat-file-list-fold';
import { trackerExcerptText, trackerReferenceText } from '../agent-chat-tracker-labels';

const translateIn =
    (locale: AppLocale): typeof translate =>
    (...parameters) => {
        useLocaleStore.setState({ locale });
        return translate(...parameters);
    };

describe('Desktop Agent Chat labels through the shared protocol catalog', () => {
    it("writes a turn duration in the language's own units, as the Codex app does", () => {
        const zh = translateIn('zh-CN');
        expect(agentChatTurnLabel({ status: 'completed', durationMs: 93_000 }, zh)).toBe(
            '用时 1分钟 33秒',
        );
        expect(agentChatTurnLabel({ status: 'completed', durationMs: 120_000 }, zh)).toBe(
            '用时 2分钟',
        );
        expect(agentChatTurnLabel({ status: 'completed', durationMs: 40_000 }, zh)).toBe(
            '用时 40秒',
        );
        expect(
            agentChatTurnLabel({ status: 'completed', durationMs: 93_000 }, translateIn('en')),
        ).toBe('Worked for 1m 33s');
    });

    it('localizes an acceptance round and check count when the card renders', () => {
        const artifact = {
            provider: 'lobehub',
            kind: 'acceptance',
            action: 'created',
            url: 'https://app.lobehub.com/acceptance/abcdef12',
            reference: 'abcdef12',
            round: 2,
            checks: 1,
        } as const;
        expect(trackerReferenceText(artifact, translateIn('zh-CN'))).not.toBe('Round 2');
        expect(trackerReferenceText(artifact, translateIn('en'))).toBe('Round 2');
        expect(trackerExcerptText(artifact, translateIn('en'))).toBe('1 check');
        expect(trackerReferenceText({ ...artifact, round: undefined }, translateIn('en'))).toBe(
            'abcdef12',
        );
    });

    it('titles edited files and names a change kind in the active language', () => {
        const en = translateIn('en');
        expect(agentChatEditedFilesTitle([{ path: '/p/a.svg', kind: 'add' }], en)).toBe(
            'Created a.svg',
        );
        expect(
            agentChatEditedFilesTitle(
                [
                    { path: '/p/a', kind: 'update' },
                    { path: '/p/b', kind: 'delete' },
                ],
                en,
            ),
        ).toBe('Edited 2 files');
        expect(agentChatChangeKindLabel('update', en)).toBe('Modified');
        expect(
            agentChatEditedFilesTitle([{ path: '/p/a.svg', kind: 'add' }], translateIn('zh-CN')),
        ).not.toBe('Created a.svg');
    });

    it('folds a turn card past three files behind a localized toggle', () => {
        expect(agentChatVisibleEditedFiles(['a', 'b', 'c'], false)).toEqual({
            visible: ['a', 'b', 'c'],
            hiddenCount: 0,
        });
        expect(agentChatVisibleEditedFiles(['a', 'b', 'c', 'd', 'e'], false)).toEqual({
            visible: ['a', 'b', 'c'],
            hiddenCount: 2,
        });
        expect(agentChatVisibleEditedFiles(['a', 'b', 'c', 'd'], true)).toEqual({
            visible: ['a', 'b', 'c', 'd'],
            hiddenCount: 0,
        });
        const en = translateIn('en');
        expect(agentChatLocalizedFileListToggle(1, en)).toBe('Show 1 more file');
        expect(agentChatLocalizedFileListToggle(2, en)).toBe('Show 2 more files');
        expect(agentChatLocalizedFileListToggle(0, en)).toBe('Show fewer files');
        expect(agentChatLocalizedFileListToggle(2, translateIn('zh-CN'))).toBe('再显示 2 个文件');
    });

    it('translates the shared work row verb, file count, and summary', () => {
        const declined: AgentChatWorkItem = {
            id: 'c',
            type: 'command',
            command: 'echo hi',
            status: 'declined',
            output: '',
        };
        const edits: AgentChatWorkItem = {
            id: 'f',
            type: 'fileChange',
            status: 'completed',
            changes: [
                { path: '/p/src/a.ts', kind: 'update', diff: '' },
                { path: '/p/docs/b.md', kind: 'add', diff: '' },
            ],
        };
        const en = translateIn('en');
        expect(describeAgentChatWork(declined, en).label).toBe('Not allowed to run');
        expect(describeAgentChatWork(edits, en).subject).toBe('a.ts +1 more');
        expect(summarizeAgentChatWork([declined, edits], en)).toBe(
            'Ran 1 command, edited 2 files, 1 failed',
        );
        expect(describeAgentChatWork(declined, translateIn('zh-CN')).label).not.toBe(
            'Not allowed to run',
        );
    });

    it('words the composer status line and item status in the active language', () => {
        const snapshot = {
            ...emptyAgentChatSnapshot('chat'),
            status: 'ready' as const,
            activeTurnId: 'turn-0',
        };
        const english = agentChatActivity(snapshot, 'Codex', {}, translateIn('en'));
        const chinese = agentChatActivity(snapshot, 'Codex', {}, translateIn('zh-CN'));
        expect(english?.kind).toBe('working');
        expect(english?.text).toBe('Mapping the terrain…');
        expect(chinese?.text).toBe('勘探思路地形…');
        expect(agentChatItemStatusLabel('declined', translateIn('en'))).toBe('Declined');
        expect(agentChatItemStatusLabel('declined', translateIn('zh-CN'))).not.toBe('Declined');
    });

    it('words request cards and the waiting line in the active language', () => {
        const zh = translateIn('zh-CN');
        const request = { id: 'r', kind: 'command' as const, command: 'make' };
        expect(agentChatApprovalChoices(request, zh).map(({ label }) => label)).toEqual([
            '运行',
            '在此对话中始终允许',
            '拒绝',
        ]);
        expect(
            agentChatRequestTitle(
                { id: 'r', kind: 'tool', name: 'Edit', summary: '/work/src/app.ts' },
                'Codex',
                zh,
            ),
        ).toBe('允许编辑 app.ts？');
        expect(agentChatWaitingText([], zh)).toBe('等待你的回答');
    });
});
