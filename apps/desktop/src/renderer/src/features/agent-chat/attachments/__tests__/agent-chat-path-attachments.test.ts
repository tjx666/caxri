import { describe, expect, it, vi } from 'vitest';

import { agentChatOsVideoPills } from '../agent-chat-path-attachments';

const environment = vi.hoisted(() => ({ isSshHost: false }));
vi.mock('../../../../stores/environment', () => ({ isSshHost: () => environment.isSshHost }));

describe('agentChatOsVideoPills', () => {
    const entries = [
        { path: '/Users/me/Desktop/Recording 13.37.mov' },
        { path: '/Users/me/notes.md' },
        { path: undefined },
    ];

    it('cites videos inline, shell-quoting a path with a space, and leaves the rest as cards', () => {
        environment.isSshHost = false;
        expect(agentChatOsVideoPills(entries, ({ path }) => path)).toEqual({
            videos: [
                {
                    kind: 'file',
                    path: '/Users/me/Desktop/Recording 13.37.mov',
                    token: "'/Users/me/Desktop/Recording 13.37.mov'",
                },
            ],
            rest: [{ path: '/Users/me/notes.md' }, { path: undefined }],
        });
    });

    it('cites nothing inline in an SSH Host window', () => {
        environment.isSshHost = true;
        expect(agentChatOsVideoPills(entries, ({ path }) => path)).toEqual({
            videos: [],
            rest: entries,
        });
        environment.isSshHost = false;
    });
});
