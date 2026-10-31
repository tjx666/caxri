import { describe, expect, it } from 'vitest';

import { agentPromptText } from '../agent-prompt-text';

describe('agentPromptText', () => {
    it('keeps newlines and tabs, normalizes line endings, and drops other control characters', () => {
        expect(agentPromptText('  Fix\r\nthis\r\tnow\u{1B}[201~\u{7F}\u{0}  ')).toBe(
            'Fix\nthis\n\tnow[201~',
        );
    });

    it('rejects anything that is not a non-empty string', () => {
        expect(agentPromptText(undefined)).toBeUndefined();
        expect(agentPromptText({ prompt: 'Fix' })).toBeUndefined();
        expect(agentPromptText(' \u{1B} ')).toBeUndefined();
    });
});
