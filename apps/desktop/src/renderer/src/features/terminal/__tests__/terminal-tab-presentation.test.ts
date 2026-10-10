import { describe, expect, it } from 'vitest';

import { terminalTabTooltip } from '../terminal-tab-presentation';

describe('terminalTabTooltip', () => {
    it('names the Chat view of an Agent tab', () => {
        expect(terminalTabTooltip('Fix login', { provider: 'codex', surface: 'chat' })).toBe(
            'Fix login (Chat)',
        );
    });

    it('keeps the plain title for an Agent in a Terminal and for a Shell', () => {
        expect(terminalTabTooltip('Fix login', { provider: 'codex' })).toBe('Fix login');
        expect(terminalTabTooltip('zsh', { provider: undefined })).toBe('zsh');
    });
});
