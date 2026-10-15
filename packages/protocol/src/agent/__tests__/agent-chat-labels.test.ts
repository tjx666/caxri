import { describe, expect, it } from 'vitest';

import { interpolate } from '../../configuration/i18n-interpolate';
import { agentChatApprovalChoices, agentChatRequestTitle } from '../agent-chat-approval';
import { agentChatChangeKindLabel } from '../agent-chat-diff';
import type { AgentChatLabelTranslate } from '../agent-chat-labels';
import { translateAgentChatLabel } from '../agent-chat-labels';
import { agentChatLabelsEn } from '../agent-chat-labels-en';
import { agentChatLabelsZhCN } from '../agent-chat-labels-zh-cn';
import {
    agentChatPermissionModeDescription,
    agentChatPermissionModeLabel,
} from '../agent-chat-permissions';
import {
    agentChatActivity,
    agentChatFailureMessage,
    agentChatItemStatusLabel,
    agentChatWorkingVerb,
} from '../agent-chat-presentation';
import { agentChatEditedFilesTitle } from '../agent-chat-turn-artifacts';
import {
    agentChatTurnLabel,
    describeAgentChatWork,
    summarizeAgentChatWork,
} from '../agent-chat-work';
import {
    commanderInboxKindLabel,
    commanderInboxReplyState,
} from '../agent-commander-inbox-presentation';
import { agentToolLabel, formatShortDuration } from '../agent-tool-presentation';

const zh: AgentChatLabelTranslate = (key, parameters) =>
    interpolate(agentChatLabelsZhCN[key], parameters);

const compareText = (left: string, right: string) => left.localeCompare(right);

const placeholders = (text: string) =>
    text
        .matchAll(/\{\{\s*(\w+)\s*\}\}/g)
        .map((match) => String(match[1]))
        .toArray()
        .toSorted(compareText);

describe('agent chat label catalogs', () => {
    it('translate every English key into a non-empty Chinese string with the same placeholders', () => {
        for (const [key, english] of Object.entries(agentChatLabelsEn)) {
            const chinese = (agentChatLabelsZhCN as Partial<Record<string, string>>)[key];
            expect(chinese, key).toBeTruthy();
            expect(placeholders(chinese ?? ''), key).toEqual(placeholders(english));
        }
        expect(Object.keys(agentChatLabelsZhCN).toSorted(compareText)).toEqual(
            Object.keys(agentChatLabelsEn).toSorted(compareText),
        );
    });

    it('defaults to English for callers without a translator', () => {
        expect(translateAgentChatLabel('agentChat.fold.workedFor', { duration: '2m' })).toBe(
            'Worked for 2m',
        );
        expect(agentChatTurnLabel({ durationMs: 121_000, status: 'completed' })).toBe(
            'Worked for 2m 1s',
        );
        expect(formatShortDuration(400)).toBe('<1s');
        expect(commanderInboxKindLabel('decision')).toBe('Decision');
    });
});

describe('agent chat labels in Simplified Chinese', () => {
    const fileChange = {
        id: 'f',
        type: 'fileChange' as const,
        status: 'completed' as const,
        changes: [
            { path: '/repo/src/a.ts', kind: 'update' as const, diff: '' },
            { path: '/repo/src/b.ts', kind: 'update' as const, diff: '' },
        ],
    };

    it('translates work rows, summaries, and turn folds', () => {
        expect(agentToolLabel('Edited', zh)).toBe('已编辑');
        expect(agentToolLabel('github', zh)).toBe('github');
        expect(describeAgentChatWork(fileChange, zh)).toMatchObject({
            label: '已编辑',
            subject: 'a.ts 等 1 个其他文件',
        });
        expect(describeAgentChatWork({ ...fileChange, status: 'failed' }, zh).label).toBe(
            interpolate(agentChatLabelsZhCN['agentChat.tool.failedTo'], {
                verb: agentChatLabelsZhCN['agentChat.tool.verb.edit'],
            }),
        );
        expect(summarizeAgentChatWork([fileChange], zh)).toBe('编辑了 2 个文件');
        expect(agentChatTurnLabel({ durationMs: 121_000, status: 'completed' }, zh)).toBe(
            '用时 2分钟 1秒',
        );
        expect(agentChatItemStatusLabel('failed', zh)).toBe('失败');
    });

    it('translates the status line, request cards, and failure banners', () => {
        expect(agentChatActivity(undefined, 'Codex', { hasConversation: true }, zh)?.text).toBe(
            '正在加载对话…',
        );
        expect(agentChatWorkingVerb('turn-1', zh)).not.toMatch(/[A-Z]/i);
        const request = {
            id: 'r',
            kind: 'command' as const,
            command: 'ls',
            itemId: 'i',
        };
        expect(agentChatRequestTitle(request, 'Codex', zh)).toBe('运行此命令？');
        expect(agentChatApprovalChoices(request, zh).map((choice) => choice.label)).toEqual([
            '运行',
            '在此对话中始终允许',
            '拒绝',
        ]);
        expect(
            agentChatFailureMessage(
                'process_exited',
                { providerName: 'codex', surface: 'mobile', canRetry: false },
                zh,
            ),
        ).toBe('Codex 意外停止。需要回复权限才能重试。');
    });

    it('translates file changes, permission levels, and Commander Inbox labels', () => {
        expect(agentChatChangeKindLabel('add', zh)).toBe('已添加');
        expect(agentChatEditedFilesTitle([{ kind: 'add', path: '/repo/a.ts' }], zh)).toBe(
            '创建了 a.ts',
        );
        expect(agentChatPermissionModeLabel('acceptEdits', 'codex', zh)).toBe('默认');
        expect(agentChatPermissionModeDescription('claude', 'readOnly', zh)).toBeUndefined();
        expect(commanderInboxKindLabel('hands', zh)).toBe('待你操作');
        expect(
            commanderInboxReplyState({ acknowledgedSequence: 2, replies: [{ sequence: 2 }] }, zh),
        ).toEqual({ isRead: true, label: 'Commander 已读' });
    });
});
