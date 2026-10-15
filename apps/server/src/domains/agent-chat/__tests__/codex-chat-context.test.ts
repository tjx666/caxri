import type { AgentChatPatchOperation, AgentChatSnapshot } from '@caxri/protocol';
import { applyAgentChatOperation, emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { CodexChatCommands } from '../codex-chat-commands';

function fixture() {
    let snapshot: AgentChatSnapshot = {
        ...emptyAgentChatSnapshot('example'),
        usage: { totalTokens: 243_000, contextWindow: 280_000 },
    };
    const apply = (operations: AgentChatPatchOperation[]): void => {
        for (const operation of operations) snapshot = applyAgentChatOperation(snapshot, operation);
    };
    const commands = new CodexChatCommands(
        { read: () => snapshot, apply, lifecycle: vi.fn() },
        { change: vi.fn() },
        () => {
            throw new Error('unused');
        },
        () => {},
        () => Promise.resolve(),
    );
    return { commands, apply, read: () => snapshot };
}

describe('Codex compaction usage boundary', () => {
    it('removes pre-compaction pressure until Codex publishes a new usage sample', () => {
        const { commands, read } = fixture();
        commands.onCompaction(true);
        commands.onCompaction(false);
        expect(read().usage).toBeUndefined();
    });

    it('keeps an authoritative post-compaction sample that arrived before the completion item', () => {
        const { commands, apply, read } = fixture();
        commands.onCompaction(true);
        apply([{ op: 'state', state: { usage: { totalTokens: 12_000, contextWindow: 280_000 } } }]);
        commands.onCompaction(false);
        expect(read().usage?.totalTokens).toBe(12_000);
    });
});
