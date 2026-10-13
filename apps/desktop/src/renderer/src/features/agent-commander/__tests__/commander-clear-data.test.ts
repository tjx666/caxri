import type {
    CommanderClearDataResult,
    CommanderDataSummary,
    CommanderTask,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { Translate } from '../../../i18n';
import { agentCommander as english } from '../../../i18n/locales/en/agent-commander';
import type { CommanderClearDataSelection } from '../commander-clear-data';
import {
    commanderClearDataOutcome,
    commanderClearDataRequest,
    commanderTaskCounts,
    defaultCommanderClearDataSelection,
    hasLearnedMemory,
    isMemoryStillInConversation,
} from '../commander-clear-data';

const strings: Readonly<Record<string, string>> = english;
const t: Translate = (key, parameters) =>
    (strings[key] ?? key).replaceAll(/\{\{(\w+)\}\}/g, (_, name: string) =>
        String(parameters?.[name] ?? ''),
    );

function task(id: string, status: CommanderTask['status']): CommanderTask {
    return {
        id,
        title: `Task ${id}`,
        status,
        projectId: null,
        sessionId: null,
        delegationId: null,
        note: null,
        pullRequestUrl: null,
        createdAt: 1,
        updatedAt: 2,
    };
}

function summary(overrides: Partial<CommanderDataSummary> = {}): CommanderDataSummary {
    return {
        tasks: [task('open-1', 'dispatched'), task('done-1', 'done'), task('dropped-1', 'dropped')],
        taskCount: 3,
        memory: [{ name: 'user.md', bytes: 120, isTemplate: true }],
        taskFiles: { count: 2, bytes: 2048 },
        inbox: { open: 1, closed: 4 },
        conversation: { agent: 'claude', isBound: true },
        ...overrides,
    };
}

function selection(
    overrides: Partial<CommanderClearDataSelection> = {},
): CommanderClearDataSelection {
    return {
        tasks: false,
        taskChoice: 'closed',
        chosenTaskIds: new Set(),
        taskFiles: false,
        inbox: false,
        memory: false,
        instructions: false,
        conversation: false,
        ...overrides,
    };
}

const result: CommanderClearDataResult = {
    tasksDeleted: 0,
    memoryReset: false,
    taskFilesDeleted: 0,
    inboxItemsDeleted: 0,
    instructionsRewritten: false,
    conversationReset: false,
};

describe('commanderTaskCounts', () => {
    it('counts the closed tasks the list leaves out, since every open task is listed first', () => {
        expect(commanderTaskCounts(summary({ taskCount: 600 }))).toEqual({
            all: 600,
            open: 1,
            closed: 599,
        });
    });
});

describe('defaultCommanderClearDataSelection', () => {
    it('opens on the finished tasks alone, leaving memory and the conversation for an explicit tick', () => {
        expect(defaultCommanderClearDataSelection(summary())).toEqual(
            selection({ tasks: true, taskChoice: 'closed' }),
        );
    });

    it('ticks nothing when every task is still open, and offers picking tasks rather than the empty finished set', () => {
        const openOnly = summary({ tasks: [task('open-1', 'pending')], taskCount: 1 });
        expect(defaultCommanderClearDataSelection(openOnly)).toMatchObject({
            tasks: false,
            taskChoice: 'chosen',
        });
    });
});

describe('commanderClearDataRequest', () => {
    const counts = commanderTaskCounts(summary());

    it('stands for nothing while nothing is ticked, so the dialog disables its button', () => {
        expect(commanderClearDataRequest(selection(), counts)).toBeUndefined();
    });

    it('deletes the finished tasks by scope, so older ones beyond the list go too', () => {
        expect(commanderClearDataRequest(selection({ tasks: true }), counts)).toEqual({
            tasks: 'closed',
        });
    });

    it('deletes the chosen tasks by id, and nothing when none is chosen', () => {
        const chosenTaskIds = new Set(['open-1']);
        expect(
            commanderClearDataRequest(
                selection({ tasks: true, taskChoice: 'chosen', chosenTaskIds }),
                counts,
            ),
        ).toEqual({ tasks: ['open-1'] });
        expect(
            commanderClearDataRequest(selection({ tasks: true, taskChoice: 'chosen' }), counts),
        ).toBeUndefined();
    });

    it('drops a task scope that would match no row', () => {
        const none = { all: 0, open: 0, closed: 0 };
        expect(
            commanderClearDataRequest(selection({ tasks: true, taskChoice: 'all' }), none),
        ).toBeUndefined();
    });

    it('leaves the instructions to the memory reset, which rewrites AGENTS.md anyway', () => {
        expect(
            commanderClearDataRequest(
                selection({ memory: true, instructions: true, conversation: true }),
                counts,
            ),
        ).toEqual({ memory: true, conversation: true });
        expect(commanderClearDataRequest(selection({ instructions: true }), counts)).toEqual({
            instructions: true,
        });
    });
});

describe('isMemoryStillInConversation', () => {
    it('warns when the running conversation already read what the reset rewrites', () => {
        expect(isMemoryStillInConversation(selection({ memory: true }), summary())).toBe(true);
        expect(isMemoryStillInConversation(selection({ instructions: true }), summary())).toBe(
            true,
        );
    });

    it('stays quiet when the conversation starts over or never started', () => {
        expect(
            isMemoryStillInConversation(selection({ memory: true, conversation: true }), summary()),
        ).toBe(false);
        const unbound = summary({ conversation: { agent: 'codex', isBound: false } });
        expect(isMemoryStillInConversation(selection({ memory: true }), unbound)).toBe(false);
    });
});

describe('hasLearnedMemory', () => {
    it('counts a memory file only once it differs from its template', () => {
        expect(hasLearnedMemory(summary())).toBe(false);
        expect(
            hasLearnedMemory(
                summary({ memory: [{ name: 'user.md', bytes: 400, isTemplate: false }] }),
            ),
        ).toBe(true);
    });
});

describe('commanderClearDataOutcome', () => {
    it('names every kind of data that went, singular where one went', () => {
        expect(
            commanderClearDataOutcome(
                {
                    ...result,
                    tasksDeleted: 3,
                    taskFilesDeleted: 1,
                    inboxItemsDeleted: 2,
                    conversationReset: true,
                },
                t,
            ),
        ).toBe('Cleared 3 tasks, 1 task file, 2 Needs you items, the conversation');
    });

    it('reports the memory reset once, not again as an instructions rewrite', () => {
        expect(
            commanderClearDataOutcome(
                { ...result, memoryReset: true, instructionsRewritten: true },
                t,
            ),
        ).toBe('Cleared the memory');
        expect(commanderClearDataOutcome({ ...result, instructionsRewritten: true }, t)).toBe(
            'Cleared the instructions',
        );
    });

    it('says so when everything ticked was already gone', () => {
        expect(commanderClearDataOutcome(result, t)).toBe('There was nothing left to clear');
    });
});
