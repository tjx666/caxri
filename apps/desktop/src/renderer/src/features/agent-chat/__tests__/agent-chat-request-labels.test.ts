import type { AgentChatApprovalRequest, AgentChatRequest } from '@caxri/protocol';
import {
    agentChatApprovalChoices,
    agentChatFailureMessage,
    agentChatFailureReasonSchema,
    agentChatRequestTitle,
    agentChatWaitingText,
} from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { useLocaleStore } from '../../../i18n';
import {
    agentChatLocalizedApprovalChoices,
    agentChatLocalizedFailureMessage,
    agentChatLocalizedRequestTitle,
    agentChatLocalizedWaitingText,
} from '../agent-chat-request-labels';

const question = { id: 'q', header: '', question: 'Which?', options: [], allowsOther: true };

const approvals: AgentChatApprovalRequest[] = [
    { id: 'r', kind: 'command', command: 'make' },
    { id: 'r', kind: 'command', networkHost: 'a.dev' },
    { id: 'r', kind: 'fileChange', decisions: ['decline', 'cancel', 'accept'] },
    { id: 'r', kind: 'tool', name: 'WebFetch' },
    { id: 'r', kind: 'tool', name: 'ExitPlanMode' },
    { id: 'r', kind: 'tool', name: 'mcp__github__create_issue', summary: '{"title":"x"}' },
    { id: 'r', kind: 'tool', name: 'Edit', summary: '/work/src/app.ts' },
    { id: 'r', kind: 'tool', name: 'WebFetch', summary: `https://example.com/${'a'.repeat(80)}` },
    { id: 'r', kind: 'tool', name: 'Bash', summary: 'git status' },
];

const requests: AgentChatRequest[] = [
    ...approvals,
    { id: 'r', kind: 'question', questions: [question] },
    { id: 'r', kind: 'question', questions: [question, { ...question, id: 'q2' }] },
];

describe('Agent Chat request labels', () => {
    afterEach(() => useLocaleStore.setState({ locale: 'en' }));

    it('matches the protocol English copy byte for byte', () => {
        useLocaleStore.setState({ locale: 'en' });
        for (const request of approvals)
            expect(agentChatLocalizedApprovalChoices(request)).toEqual(
                agentChatApprovalChoices(request),
            );
        for (const request of requests) {
            expect(agentChatLocalizedRequestTitle(request, 'Codex')).toBe(
                agentChatRequestTitle(request, 'Codex'),
            );
            expect(agentChatLocalizedWaitingText([request])).toBe(agentChatWaitingText([request]));
        }
        for (const reason of agentChatFailureReasonSchema.options)
            expect(agentChatLocalizedFailureMessage(reason, 'Codex')).toBe(
                agentChatFailureMessage(reason, { providerName: 'Codex', surface: 'desktop' }),
            );
    });

    it('translates the copy in Simplified Chinese', () => {
        useLocaleStore.setState({ locale: 'zh-CN' });
        expect(agentChatLocalizedApprovalChoices(approvals[0]).map(({ label }) => label)).toEqual([
            '运行',
            '在此对话中始终允许',
            '拒绝',
        ]);
        expect(agentChatLocalizedRequestTitle(approvals[6], 'Codex')).toBe('允许编辑 app.ts？');
        expect(agentChatLocalizedWaitingText([])).toBe('等待你的回答');
    });
});
