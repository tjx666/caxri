import { describe, expect, it, vi } from 'vitest';

import type { AgentChatUserMessageMenuInput } from '../agent-chat-user-message-menu';
import { agentChatReplyMenu, agentChatUserMessageMenu } from '../agent-chat-user-message-menu';

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
        isRestoring: false,
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

function selectSetAsGoal(entries: ReturnType<typeof agentChatUserMessageMenu>): void {
    const goal = entries.find(
        (entry) => entry && entry.type !== 'separator' && entry.label === 'Set as Goal',
    );
    if (goal && goal.type !== 'separator' && goal.type !== 'submenu') goal.onSelect();
}

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

    it('copies the selection inside the message and still offers the whole message', () => {
        const onCopy = vi.fn();
        const menuInput = input({ selectedText: 'the bug', onCopy });
        const [copy, copyMessage] = agentChatUserMessageMenu(menuInput);
        expect(describeEntry(copy)).toEqual({ label: 'Copy', disabledReason: undefined });
        expect(describeEntry(copyMessage)).toEqual({
            label: 'Copy Message',
            disabledReason: undefined,
        });
        if (copy && copy.type !== 'separator' && copy.type !== 'submenu') copy.onSelect();
        expect(onCopy).toHaveBeenCalledWith('the bug');
    });

    it('offers Set as Goal after Add to Message when the provider has a goal command', () => {
        const onSetGoal = vi.fn();
        const entries = agentChatUserMessageMenu(
            input({ text: '  ship the release  ', onQuote: vi.fn(), onSetGoal }),
        );
        expect(visible(entries).slice(0, 3)).toEqual([
            { label: 'Copy Message', disabledReason: undefined },
            { label: 'Add to Message', disabledReason: undefined },
            { label: 'Set as Goal', disabledReason: undefined },
        ]);
        selectSetAsGoal(entries);
        expect(onSetGoal).toHaveBeenCalledWith('ship the release');
    });

    it('sets only the selection as the goal while one is inside the message', () => {
        const onSetGoal = vi.fn();
        const entries = agentChatUserMessageMenu(input({ selectedText: 'the bug', onSetGoal }));
        selectSetAsGoal(entries);
        expect(onSetGoal).toHaveBeenCalledWith('the bug');
    });

    it('leaves out Set as Goal for a message with no text', () => {
        const entries = agentChatUserMessageMenu(input({ text: '', onSetGoal: vi.fn() }));
        expect(visible(entries)).toEqual([
            '---',
            { label: 'Edit from Here', disabledReason: undefined },
            { label: 'Fork from Here', disabledReason: undefined },
            { label: 'Restore Code to Here', disabledReason: undefined },
        ]);
    });

    it('keeps disabled actions with their reason and leaves out actions not offered', () => {
        const menuInput = input({
            edit: 'agentChat.edit.stopToEdit',
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

    it('disables Restore Code to Here while one from this message is running', () => {
        const menuInput = input({ isRestoring: true });
        expect(visible(agentChatUserMessageMenu(menuInput)).at(-1)).toEqual({
            label: 'Restore Code to Here',
            disabledReason: 'Restoring code…',
        });
    });

    it('offers no Copy for a message of images alone', () => {
        const menuInput = input({ text: '', edit: undefined, fork: undefined, restore: undefined });
        expect(visible(agentChatUserMessageMenu(menuInput))).toEqual(['---']);
    });
});

describe('agentChatReplyMenu', () => {
    it('offers Copy Message for the Markdown source and Add to Message for the whole reply', () => {
        const onCopy = vi.fn();
        const onQuote = vi.fn();
        const entries = agentChatReplyMenu({ text: '**Done**', selectedText: '', onCopy, onQuote });
        expect(visible(entries)).toEqual([
            { label: 'Copy Message', disabledReason: undefined },
            { label: 'Add to Message', disabledReason: undefined },
        ]);
        for (const entry of entries)
            if (entry && entry.type !== 'separator' && entry.type !== 'submenu') entry.onSelect();
        expect(onCopy).toHaveBeenCalledWith('**Done**');
        expect(onQuote).toHaveBeenCalledWith('**Done**');
    });

    it('copies and quotes the selection inside the reply, keeping Copy Message for the whole reply', () => {
        const onCopy = vi.fn();
        const onQuote = vi.fn();
        const entries = agentChatReplyMenu({
            text: 'all of it',
            selectedText: 'of',
            onCopy,
            onQuote,
        });
        expect(visible(entries)).toEqual([
            { label: 'Copy', disabledReason: undefined },
            { label: 'Copy Message', disabledReason: undefined },
            { label: 'Add to Message', disabledReason: undefined },
        ]);
        for (const entry of entries)
            if (entry && entry.type !== 'separator' && entry.type !== 'submenu') entry.onSelect();
        expect(onCopy).toHaveBeenCalledWith('of');
        expect(onCopy).toHaveBeenCalledWith('all of it');
        expect(onQuote).toHaveBeenCalledWith('of');
    });

    it('leaves out Add to Message where there is no Chat to write to', () => {
        const entries = agentChatReplyMenu({ text: 'reply', selectedText: '', onCopy: vi.fn() });
        expect(visible(entries)).toEqual([{ label: 'Copy Message', disabledReason: undefined }]);
    });
});
