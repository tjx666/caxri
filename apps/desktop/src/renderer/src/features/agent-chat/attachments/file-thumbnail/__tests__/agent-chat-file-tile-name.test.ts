import { describe, expect, it } from 'vitest';

import { agentChatFileTileName } from '../agent-chat-file-tile-name';

describe('agentChatFileTileName', () => {
    it('keeps a name that fits the tile', () => {
        expect(agentChatFileTileName('季度预算说明_请财务确认.pdf')).toBe(
            '季度预算说明_请财务确认.pdf',
        );
        expect(agentChatFileTileName('src')).toBe('src');
    });

    it('shortens a long name in the middle, keeping its end and extension', () => {
        expect(agentChatFileTileName('Roadmap 草案 for the desktop app 下半年.pdf')).toBe(
            'Roadmap 草案 fo… 下半年.pdf',
        );
        expect(agentChatFileTileName('a3f9c0d17b2e4856f0c1d2e3b4a59687.mp3')).toBe(
            'a3f9c0d17b2e48…a59687.mp3',
        );
    });

    it('treats a long trailing dot segment as part of the name, not an extension', () => {
        expect(agentChatFileTileName('release.candidate-build-for-the-desktop-app')).toBe(
            'release.candidate-…op-app',
        );
    });
});
