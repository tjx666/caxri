import { describe, expect, it } from 'vitest';

import { interpolate } from '../../../configuration/i18n-interpolate';
import type { AgentChatItem } from '../../agent-chat-contract';
import type { AgentChatLabelTranslate } from '../../agent-chat-labels';
import { agentChatLabelsZhCN } from '../../agent-chat-labels-zh-cn';
import { describeAgentChatWork } from '../../agent-chat-work';
import { agentToolLabel } from '../../tool-rows/agent-tool-labels';

const zh: AgentChatLabelTranslate = (key, parameters) =>
    interpolate(agentChatLabelsZhCN[key], parameters);

const search: AgentChatItem = {
    id: 's',
    type: 'command',
    command: 'grep -n error /tmp/tasks/abc.output',
    status: 'completed',
    output: '',
    pathTarget: { kind: 'taskOutput', title: 'dev server' },
};

describe('withAgentChatPathTarget wording', () => {
    it('words a search of a recognized file in English by default', () => {
        expect(describeAgentChatWork(search)).toMatchObject({
            kind: 'search',
            subject: 'error in dev server',
        });
    });

    it('words it in the reader language and keeps the label translatable', () => {
        expect(describeAgentChatWork(search, zh).subject).toBe('在 dev server 中搜索 error');
        const read = describeAgentChatWork({ ...search, command: 'cat /tmp/tasks/abc.output' }, zh);
        expect(read.subject).toBe('dev server');
        // The label is the tool-table source text; the completed row translates it through the catalog.
        expect(read.label).toBe('已查看输出');
        expect(agentToolLabel('Checked output', zh)).toBe('已查看输出');
    });
});
