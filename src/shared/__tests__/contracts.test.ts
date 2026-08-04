import { describe, expect, it } from 'vitest';

import { requestEnvelopeSchema, requestSchemas } from '../contracts';

describe('requestEnvelopeSchema', () => {
    it.each(['constructor', 'toString', '__proto__'])('rejects inherited method %s', (method) => {
        expect(
            requestEnvelopeSchema.safeParse({ id: 'request-1', method, params: {} }).success,
        ).toBe(false);
    });
});

describe('files.write contract', () => {
    it('supports the largest configurable text file without exceeding the IPC boundary', () => {
        const maximum = 16 * 1024 * 1024;
        const base = { sessionId: 'session-1', path: '/project/note.txt' };

        expect(
            requestSchemas['files.write'].safeParse({ ...base, content: 'x'.repeat(maximum) })
                .success,
        ).toBe(true);
        expect(
            requestSchemas['files.write'].safeParse({ ...base, content: 'x'.repeat(maximum + 1) })
                .success,
        ).toBe(false);
    });
});

describe('Project and Session contracts', () => {
    it('keeps the selected root on Project creation and requires Sessions to reference it by id', () => {
        expect(requestSchemas['project.create'].safeParse({ rootPath: '/project' }).success).toBe(
            true,
        );
        expect(
            requestSchemas['session.create'].safeParse({
                projectId: 'project-1',
                defaultAgent: 'codex',
            }).success,
        ).toBe(true);
        expect(
            requestSchemas['session.create'].safeParse({
                rootPath: '/project',
                defaultAgent: 'codex',
            }).success,
        ).toBe(false);
    });
});

describe('Terminal layout contract', () => {
    const state = {
        sessionId: 'session-1',
        openTabs: [],
        inspectorMode: 'files',
    };

    it('accepts bounded split trees and rejects duplicate Terminal attachments', () => {
        const group = {
            type: 'group' as const,
            id: 'group-1',
            terminalIds: ['terminal-1'],
            activeTerminalId: 'terminal-1',
        };
        expect(
            requestSchemas['session.updateState'].safeParse({
                ...state,
                layout: {
                    activeGroupId: 'group-1',
                    root: {
                        type: 'split',
                        id: 'split-1',
                        direction: 'horizontal',
                        ratio: 0.5,
                        first: group,
                        second: {
                            ...group,
                            id: 'group-2',
                            terminalIds: ['terminal-2'],
                            activeTerminalId: 'terminal-2',
                        },
                    },
                },
            }).success,
        ).toBe(true);
        expect(
            requestSchemas['session.updateState'].safeParse({
                ...state,
                layout: {
                    root: {
                        type: 'split',
                        id: 'split-1',
                        direction: 'horizontal',
                        ratio: 0.5,
                        first: group,
                        second: { ...group, id: 'group-2' },
                    },
                },
            }).success,
        ).toBe(false);
    });
});
