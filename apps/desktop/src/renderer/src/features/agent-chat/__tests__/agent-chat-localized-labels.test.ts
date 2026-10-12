import type { AgentChatWorkItem, AppLocale } from '@caxri/protocol';
import { emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate, useLocaleStore } from '../../../i18n';
import {
    agentChatLocalizedChangeKindLabel,
    agentChatLocalizedEditedFilesTitle,
} from '../agent-chat-diff-labels';
import { agentChatActivity, agentChatItemStatusLabel } from '../agent-chat-presentation';
import {
    agentChatTurnLabel,
    describeAgentChatWork,
    summarizeAgentChatWork,
} from '../agent-chat-timeline';
import { trackerExcerptText, trackerReferenceText } from '../agent-chat-tracker-labels';

const translateIn =
    (locale: AppLocale): typeof translate =>
    (...parameters) => {
        useLocaleStore.setState({ locale });
        return translate(...parameters);
    };

describe('Desktop Agent Chat labels over the shared English rules', () => {
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
        expect(agentChatLocalizedEditedFilesTitle([{ path: '/p/a.svg', kind: 'add' }], en)).toBe(
            'Created a.svg',
        );
        expect(
            agentChatLocalizedEditedFilesTitle(
                [
                    { path: '/p/a', kind: 'update' },
                    { path: '/p/b', kind: 'delete' },
                ],
                en,
            ),
        ).toBe('Edited 2 files');
        expect(agentChatLocalizedChangeKindLabel('update', en)).toBe('Modified');
        expect(
            agentChatLocalizedEditedFilesTitle(
                [{ path: '/p/a.svg', kind: 'add' }],
                translateIn('zh-CN'),
            ),
        ).not.toBe('Created a.svg');
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
            activeTurnId: 'turn-1',
        };
        const english = agentChatActivity(snapshot, 'Codex', {}, translateIn('en'));
        const chinese = agentChatActivity(snapshot, 'Codex', {}, translateIn('zh-CN'));
        expect(english?.kind).toBe('working');
        expect(chinese?.text).not.toBe(english?.text);
        expect(agentChatItemStatusLabel('declined', translateIn('en'))).toBe('Declined');
        expect(agentChatItemStatusLabel('declined', translateIn('zh-CN'))).not.toBe('Declined');
    });
});
