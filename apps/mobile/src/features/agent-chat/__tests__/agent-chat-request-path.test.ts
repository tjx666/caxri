import { describe, expect, it } from 'vitest';

import { agentChatRequestPathLabel } from '../agent-chat-request-path';

describe('agentChatRequestPathLabel', () => {
    it('shows a path inside the Project root relative to it', () => {
        expect(agentChatRequestPathLabel('/work/app/src/a/b.ts', '/work/app')).toBe('src/a/b.ts');
        expect(agentChatRequestPathLabel('/work/app', '/work/app')).toBe('.');
    });

    it('does not treat a sibling folder sharing a prefix as inside the root', () => {
        expect(agentChatRequestPathLabel('/work/app-two/src/a.ts', '/work/app')).toBe('…/src/a.ts');
    });

    it('keeps the last two segments of a path outside the root', () => {
        expect(agentChatRequestPathLabel('/Users/me/code/app/src', undefined)).toBe('…/app/src');
        expect(agentChatRequestPathLabel('/tmp/x')).toBe('/tmp/x');
    });

    it('leaves relative paths alone and handles Windows separators', () => {
        expect(agentChatRequestPathLabel('src/a.ts', '/work/app')).toBe('src/a.ts');
        expect(
            agentChatRequestPathLabel(String.raw`C:\work\app\src\a.ts`, String.raw`C:\work\app`),
        ).toBe(String.raw`src\a.ts`);
    });
});
