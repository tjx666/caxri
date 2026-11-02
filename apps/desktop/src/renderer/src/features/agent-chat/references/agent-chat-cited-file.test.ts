import type { AgentChatItem } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentChatCitedFileFallback, agentChatTouchedFilePaths } from './agent-chat-cited-file';

const write: AgentChatItem = {
    id: 'w',
    type: 'fileChange',
    status: 'completed',
    changes: [
        { path: '/home/u/Documents/launch/plan-config-decisions.md', kind: 'add', diff: '' },
        { path: 'relative/ignored.md', kind: 'add', diff: '' },
    ],
};
const read: AgentChatItem = {
    id: 'r',
    type: 'toolCall',
    name: 'Read',
    summary: '/home/u/Documents/launch/live-test-plan.md',
    status: 'completed',
};
const shellRead: AgentChatItem = {
    id: 'c',
    type: 'command',
    command: 'cat /tmp/notes/stripe-live-runbook.md',
    status: 'completed',
    output: '',
};
const message: AgentChatItem = {
    id: 'm',
    type: 'agentMessage',
    text: '/not/a/tool/path.md',
    streaming: false,
};

describe('agentChatTouchedFilePaths', () => {
    it('collects absolute paths from file changes, file tools, and shell reads across sources', () => {
        expect([
            ...agentChatTouchedFilePaths([
                [write, message],
                [read, shellRead],
            ]),
        ]).toEqual([
            '/home/u/Documents/launch/plan-config-decisions.md',
            '/home/u/Documents/launch/live-test-plan.md',
            '/tmp/notes/stripe-live-runbook.md',
        ]);
    });
});

describe('agentChatCitedFileFallback', () => {
    const touched = new Set([
        '/home/u/Documents/launch/plan-config-decisions.md',
        '/work/a/README.md',
        '/work/b/README.md',
    ]);

    it('maps a bare name or a partial path to the one touched file it ends with', () => {
        expect(agentChatCitedFileFallback('plan-config-decisions.md', touched)).toBe(
            '/home/u/Documents/launch/plan-config-decisions.md',
        );
        expect(agentChatCitedFileFallback('launch/plan-config-decisions.md', touched)).toBe(
            '/home/u/Documents/launch/plan-config-decisions.md',
        );
    });

    it('matches whole path segments only', () => {
        expect(agentChatCitedFileFallback('config-decisions.md', touched)).toBeUndefined();
    });

    it('gives up when several touched files share the name', () => {
        expect(agentChatCitedFileFallback('README.md', touched)).toBeUndefined();
    });

    it('leaves absolute, home, dot-relative, and file URL citations alone', () => {
        for (const target of [
            '/elsewhere/plan-config-decisions.md',
            '~/plan-config-decisions.md',
            './plan-config-decisions.md',
            'file:///plan-config-decisions.md',
        ])
            expect(agentChatCitedFileFallback(target, touched)).toBeUndefined();
    });
});
