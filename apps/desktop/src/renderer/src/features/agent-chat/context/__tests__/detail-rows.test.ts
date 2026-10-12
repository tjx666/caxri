import { describe, expect, it } from 'vitest';

import { translate } from '../../../../i18n';
import {
    contextSourceLabel,
    includedCaption,
    mcpRows,
    memoryRows,
    messageRows,
} from '../detail-rows';
import { composition } from './fixtures';

describe('context detail rows', () => {
    it('lists MCP servers with their tools, muting a fully deferred server', () => {
        const rows = mcpRows(translate, composition());
        expect(rows.map((row) => [row.name, row.meta, row.isMuted])).toEqual([
            ['github', 'tools: 2', false],
            ['linear', 'tools: 1', false],
            ['docs', 'tools: 1, 1 deferred', true],
        ]);
        expect(rows[2].children?.[0]).toMatchObject({
            name: 'read',
            meta: 'deferred',
            isMuted: true,
        });
    });

    it('shortens memory file paths and keeps the full path for the tooltip', () => {
        expect(memoryRows(composition())).toEqual([
            {
                id: '/repo/AGENTS.md',
                name: 'AGENTS.md',
                meta: 'Project',
                tokens: 6_000,
                tooltip: '/repo/AGENTS.md',
            },
        ]);
    });

    it('breaks the conversation down by kind with each tool under its calls and results', () => {
        const messages = {
            toolCalls: 1_000,
            toolResults: 20_000,
            attachments: 0,
            assistant: 5_000,
            user: 0,
            other: 0,
            tools: [
                { name: 'Read', callTokens: 400, resultTokens: 15_000 },
                { name: 'Bash', callTokens: 600, resultTokens: 5_000 },
            ],
            attachmentKinds: [],
        };
        const rows = messageRows(translate, messages, composition({ messages }));
        expect(rows.map((row) => row.id)).toEqual(['toolResults', 'assistant', 'toolCalls']);
        expect(rows[0].children?.map((child) => child.name)).toEqual(['Read', 'Bash']);
        expect(rows[2].children?.map((child) => child.name)).toEqual(['Bash', 'Read']);
    });

    it('translates known sources and captions capped lists', () => {
        expect(contextSourceLabel(translate, 'projectSettings')).toBe('project');
        expect(contextSourceLabel(translate, 'somethingNew')).toBe('somethingNew');
        expect(includedCaption(translate, 3, 3, 1_200)).toBe('3 listed · 1.2k');
        expect(includedCaption(translate, 3, 5, 1_200)).toBe('3 of 5 listed · 1.2k');
    });
});
