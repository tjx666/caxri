import { describe, expect, it } from 'vitest';

import {
    AGENT_CHAT_LONG_PASTE_THRESHOLD,
    MAX_AGENT_CHAT_MESSAGE_LENGTH,
} from '../../agent/agent-chat-limits.js';
import { MAX_TERMINAL_INPUT_PAYLOAD_LENGTH } from '../../domain/domain.js';
import { MAX_LONG_PASTE_BYTES } from '../../domain/terminal-long-paste.js';
import { settingsSpec } from '../settings-spec.js';

describe('settingsSpec', () => {
    it('keeps the maximum threshold inside native input while allowing larger saved pastes', () => {
        const threshold = settingsSpec.find((spec) => spec.key === 'terminal.longPasteThreshold');
        expect(threshold).toMatchObject({
            kind: 'integer',
            max: MAX_TERMINAL_INPUT_PAYLOAD_LENGTH - 12,
        });
        expect(MAX_LONG_PASTE_BYTES).toBeGreaterThan(MAX_TERMINAL_INPUT_PAYLOAD_LENGTH);
    });

    it('bounds the Chat long paste threshold by the message limit and defaults to the Chat contract', () => {
        const threshold = settingsSpec.find((spec) => spec.key === 'agentChat.longPasteThreshold');
        expect(threshold).toMatchObject({
            kind: 'integer',
            default: AGENT_CHAT_LONG_PASTE_THRESHOLD,
            max: MAX_AGENT_CHAT_MESSAGE_LENGTH,
        });
    });

    it('ships newcomer-friendly defaults', () => {
        const defaultOf = (key: string) => {
            const spec = settingsSpec.find((entry) => entry.key === key);
            return spec !== undefined && 'default' in spec ? spec.default : undefined;
        };
        expect(defaultOf('session.openAgentsInChat')).toBe(true);
        expect(defaultOf('agents.notifications.completionThresholdSeconds')).toBe(15);
        expect(defaultOf('git.fetchGitHubAvatars')).toBe(false);
    });
});
