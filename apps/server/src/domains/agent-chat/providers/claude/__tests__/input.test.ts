import type { AgentChatCommand } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { ClaudeCommandList, claudeUserPrompt } from '../input';

const image = {
    mediaType: 'image/png' as const,
    data: 'iVBORw0KGgo=',
    thumbnail: 'data:image/jpeg;base64,/9j/',
};

describe('claudeUserPrompt', () => {
    it('sends the text ahead of its images, as the Claude Code TUI does', () => {
        const { message } = claudeUserPrompt({
            uuid: crypto.randomUUID(),
            turnId: 'turn-1',
            sessionId: 'session-1',
            text: 'compare [Image #1] with [Image #2]',
            images: [image, image],
        });
        expect(message.message.content).toEqual([
            { type: 'text', text: 'compare [Image #1] with [Image #2]' },
            {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: image.data },
            },
            {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: image.data },
            },
        ]);
    });

    it('sends an image-only message without an empty text block', () => {
        const { message } = claudeUserPrompt({
            uuid: crypto.randomUUID(),
            turnId: 'turn-1',
            sessionId: 'session-1',
            text: '',
            images: [image],
        });
        expect(message.message.content).toHaveLength(1);
    });
});

describe('ClaudeCommandList', () => {
    function published(commands: unknown): AgentChatCommand[] {
        let result: AgentChatCommand[] = [];
        new ClaudeCommandList((next) => {
            result = next;
        }).report(commands);
        return result;
    }

    it("marks Claude Code's built-in /goal so the composer enters Goal mode", () => {
        expect(
            published([
                {
                    name: 'goal',
                    description: 'Set a goal',
                    argumentHint: '',
                    builtin: true,
                },
            ]),
        ).toEqual([{ name: 'goal', description: 'Set a goal', goal: true }]);
    });

    it('leaves a custom /goal unmarked, running like any other command', () => {
        expect(
            published([{ name: 'goal', description: 'My goal skill', argumentHint: '' }]),
        ).toEqual([{ name: 'goal', description: 'My goal skill' }]);
    });
});
