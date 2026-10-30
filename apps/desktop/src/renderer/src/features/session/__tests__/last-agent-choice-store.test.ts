import { describe, expect, it } from 'vitest';

import { isLastUsedAgentRow, parseLastAgentChoice } from '../last-agent-choice-store';

describe('parseLastAgentChoice', () => {
    it('keeps a Terminal kind Caxri ships', () => {
        expect(parseLastAgentChoice('codex')).toEqual({ kind: 'codex' });
        expect(parseLastAgentChoice('shell')).toEqual({ kind: 'shell' });
    });

    it('reads a missing, retired, or corrupt entry as no choice', () => {
        expect(parseLastAgentChoice(undefined)).toEqual({ kind: undefined });
        expect(parseLastAgentChoice('retired-agent')).toEqual({ kind: undefined });
        expect(parseLastAgentChoice({ kind: 'codex' })).toEqual({ kind: undefined });
    });
});

describe('isLastUsedAgentRow', () => {
    it('marks only the repeated row that is not already the configured Default', () => {
        expect(isLastUsedAgentRow('codex', { isDefault: false, repeatedKind: 'codex' })).toBe(true);
        expect(isLastUsedAgentRow('claude', { isDefault: false, repeatedKind: 'codex' })).toBe(
            false,
        );
        expect(isLastUsedAgentRow('codex', { isDefault: true, repeatedKind: 'codex' })).toBe(false);
        expect(isLastUsedAgentRow('codex', { isDefault: false, repeatedKind: undefined })).toBe(
            false,
        );
    });
});
