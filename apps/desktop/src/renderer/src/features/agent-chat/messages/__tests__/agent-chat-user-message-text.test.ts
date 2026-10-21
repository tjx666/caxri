import { describe, expect, it } from 'vitest';

import {
    agentChatFirstImageNumber,
    agentChatUserMessageSegments,
} from '../agent-chat-user-message-text';

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
            { kind: 'image', text: '[Image #1]', number: 1, index: 0 },
            { kind: 'text', text: ' with [Image #3]' },
        ]);
        expect(agentChatUserMessageSegments('[Image #1]', { withFiles: false })).toEqual([
            { kind: 'text', text: '[Image #1]' },
        ]);
    });

    it('maps placeholders the Claude Code CLI numbered across the conversation onto the message images', () => {
        expect(
            agentChatUserMessageSegments('[Image #3] and [Image #4], not [Image #6]', {
                withFiles: false,
                imageCount: 2,
            }),
        ).toEqual([
            { kind: 'image', text: '[Image #3]', number: 3, index: 0 },
            { kind: 'text', text: ' and ' },
            { kind: 'image', text: '[Image #4]', number: 4, index: 1 },
            { kind: 'text', text: ', not [Image #6]' },
        ]);
    });
});

describe('agentChatFirstImageNumber', () => {
    it('numbers from 1 when a placeholder names one of the message images', () => {
        expect(agentChatFirstImageNumber('see [Image #2] and [Image #9]', 2)).toBe(1);
    });

    it('starts from the lowest placeholder when the placeholders fit the message images', () => {
        expect(agentChatFirstImageNumber('what is in [Image #3]?', 1)).toBe(3);
        expect(agentChatFirstImageNumber('[Image #2] and [Image #3]', 2)).toBe(2);
        expect(agentChatFirstImageNumber('[Image #1] and [Image #2]', 2)).toBe(1);
    });

    it('is undefined when the text places no image', () => {
        expect(agentChatFirstImageNumber('no placeholders', 1)).toBeUndefined();
        expect(agentChatFirstImageNumber('[Image #1]', 0)).toBeUndefined();
    });
});
