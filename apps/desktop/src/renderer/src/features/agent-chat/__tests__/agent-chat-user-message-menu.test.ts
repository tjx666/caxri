import { describe, expect, it, vi } from 'vitest';

import type { AgentChatUserMessageMenuInput } from '../agent-chat-user-message-menu';
import { agentChatUserMessageMenu } from '../agent-chat-user-message-menu';

function input(
    overrides: Partial<AgentChatUserMessageMenuInput> = {},
): AgentChatUserMessageMenuInput {
    return {
        text: 'fix the bug',
        selectedText: '',
        edit: null,
        fork: null,
        restore: null,
        isForking: false,
        onCopy: vi.fn(),
        onEdit: vi.fn(),
        onFork: vi.fn(),
        onRestore: vi.fn(),
        ...overrides,
    };
}

type MenuSlot = ReturnType<typeof agentChatUserMessageMenu>[number];

function describeEntry(entry: MenuSlot): unknown {
    if (!entry) return undefined;
    if (entry.type === 'separator') return '---';
    if (entry.type === 'submenu') return entry.label;
    return { label: entry.label, disabledReason: entry.disabledReason };
}

const visible = (entries: ReturnType<typeof agentChatUserMessageMenu>): unknown[] =>
    entries.filter(Boolean).map((entry) => describeEntry(entry));

describe('agentChatUserMessageMenu', () => {
    it('offers Copy Message and every enabled rewind action', () => {
        const menuInput = input();
        expect(visible(agentChatUserMessageMenu(menuInput))).toEqual([
            { label: 'Copy Message', disabledReason: undefined },
            '---',
            { label: 'Edit from Here', disabledReason: undefined },
            { label: 'Fork from Here', disabledReason: undefined },
            { label: 'Restore Code to Here', disabledReason: undefined },
        ]);
    });

    it('copies the selection inside the message instead of the whole text', () => {
        const onCopy = vi.fn();
        const menuInput = input({ selectedText: 'the bug', onCopy });
        const [copy] = agentChatUserMessageMenu(menuInput);
        expect(describeEntry(copy)).toEqual({ label: 'Copy', disabledReason: undefined });
        if (copy && copy.type !== 'separator' && copy.type !== 'submenu') copy.onSelect();
        expect(onCopy).toHaveBeenCalledWith('the bug');
    });

    it('keeps disabled actions with their reason and leaves out actions not offered', () => {
        const menuInput = input({
            edit: 'Stop the running turn to edit from here',
            restore: undefined,
            isForking: true,
        });
        expect(visible(agentChatUserMessageMenu(menuInput))).toEqual([
            { label: 'Copy Message', disabledReason: undefined },
            '---',
            { label: 'Edit from Here', disabledReason: 'Stop the running turn to edit from here' },
            {
                label: 'Fork from Here',
                disabledReason: 'A fork from this message is already opening',
            },
        ]);
    });

    it('offers no Copy for a message of images alone', () => {
        const menuInput = input({ text: '', edit: undefined, fork: undefined, restore: undefined });
        expect(visible(agentChatUserMessageMenu(menuInput))).toEqual(['---']);
    });
});
