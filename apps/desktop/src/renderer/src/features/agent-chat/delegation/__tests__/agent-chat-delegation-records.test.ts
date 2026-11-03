import type { AgentChatItem } from '@caxri/protocol';
import { foldAgentChatTurn } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { delegationRecordsOf, isDelegationRecordItem } from '../agent-chat-delegation-records';

const command: AgentChatItem = {
    command: 'caxri agent delegate create',
    id: 'c1',
    output: '',
    status: 'completed',
    type: 'command',
};
const delegating: AgentChatItem = {
    ...command,
    delegations: [
        { delegationId: 'dispatch-1', sessionId: 's1' },
        { delegationId: 'dispatch-2', sessionId: 's2' },
    ],
    id: 'c2',
};

describe('delegation records', () => {
    it('reads the stamped delegations of a command and nothing from other items', () => {
        expect(delegationRecordsOf(delegating)).toHaveLength(2);
        expect(delegationRecordsOf(command)).toEqual([]);
        expect(delegationRecordsOf({ id: 'u', text: 'hi', type: 'userMessage' })).toEqual([]);
    });

    it('keeps a delegating command in view when its turn folds', () => {
        const items: AgentChatItem[] = [
            { id: 'u', text: 'go', type: 'userMessage' },
            command,
            delegating,
            { id: 'a', streaming: false, text: 'Done', type: 'agentMessage' },
        ];
        const ids = foldAgentChatTurn(items, 'a', isDelegationRecordItem).map((part) =>
            part.kind === 'kept' ? part.item.id : 'fold',
        );
        expect(ids).toEqual(['u', 'fold', 'c2', 'a']);
    });
});
