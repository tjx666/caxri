import { describe, expect, it } from 'vitest';

import type { AgentChatTimelineEntry } from '../transcript/agent-chat-timeline';
import { agentChatReferenceUrls } from './agent-chat-reference-urls';

describe('agentChatReferenceUrls', () => {
    it('reads links from messages and the pull requests commands filed, skipping a streaming reply', () => {
        const entries: AgentChatTimelineEntry[] = [
            {
                kind: 'turn',
                id: 't1',
                status: 'completed',
                entries: [
                    {
                        kind: 'item',
                        item: {
                            id: 'u1',
                            type: 'userMessage',
                            text: 'Fix https://github.com/acme/app/issues/7 please',
                        },
                    },
                ],
            },
            {
                kind: 'work',
                id: 'w1',
                items: [
                    {
                        id: 'c1',
                        type: 'command',
                        command: 'gh pr create --title "Fix"',
                        status: 'completed',
                        output: 'https://github.com/acme/app/pull/12\n',
                    },
                ],
            },
            {
                kind: 'item',
                item: {
                    id: 'a1',
                    type: 'agentMessage',
                    text: 'Opened [the PR](https://github.com/acme/app/pull/12).',
                    streaming: false,
                },
            },
            {
                kind: 'item',
                item: {
                    id: 'a2',
                    type: 'agentMessage',
                    text: 'Also https://linear.app/acme/issue/ENG-1',
                    streaming: true,
                },
            },
        ];
        expect(agentChatReferenceUrls(entries)).toEqual([
            'https://github.com/acme/app/issues/7',
            'https://github.com/acme/app/pull/12',
            'https://github.com/acme/app/pull/12',
        ]);
    });
});
