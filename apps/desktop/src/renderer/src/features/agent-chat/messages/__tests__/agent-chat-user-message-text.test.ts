import { describe, expect, it } from 'vitest';

import { agentChatUserMessageSegments } from '../agent-chat-user-message-text';

describe('agentChatUserMessageSegments', () => {
    it('splits text around web links and file paths in order', () => {
        expect(
            agentChatUserMessageSegments('https://lobehub.com 流量怎么样, see src/app.ts:12', {
                withFiles: true,
            }),
        ).toEqual([
            { kind: 'url', text: 'https://lobehub.com', url: 'https://lobehub.com' },
            { kind: 'text', text: ' 流量怎么样, see ' },
            { kind: 'file', text: 'src/app.ts:12', file: 'src/app.ts:12' },
        ]);
    });

    it('keeps a path inside a URL as part of the link, and paths as text when files cannot open', () => {
        expect(
            agentChatUserMessageSegments('https://a.dev/src/x.ts and src/y.ts:1', {
                withFiles: false,
            }),
        ).toEqual([
            { kind: 'url', text: 'https://a.dev/src/x.ts', url: 'https://a.dev/src/x.ts' },
            { kind: 'text', text: ' and src/y.ts:1' },
        ]);
    });

    it("marks the placeholders of the message's own images", () => {
        expect(
            agentChatUserMessageSegments('compare [Image #1] with [Image #3]', {
                withFiles: false,
                imageCount: 2,
            }),
        ).toEqual([
            { kind: 'text', text: 'compare ' },
            { kind: 'image', text: '[Image #1]', number: 1 },
            { kind: 'text', text: ' with [Image #3]' },
        ]);
        expect(agentChatUserMessageSegments('[Image #1]', { withFiles: false })).toEqual([
            { kind: 'text', text: '[Image #1]' },
        ]);
    });
});
