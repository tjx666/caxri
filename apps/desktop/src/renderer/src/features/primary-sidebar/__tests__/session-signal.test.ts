import { describe, expect, it } from 'vitest';

import { sessionSignalPresentation } from '../session-signal';

const t = ((key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key) as never;

describe('sessionSignalPresentation', () => {
    it('shows nothing without a signal', () => {
        expect(sessionSignalPresentation(undefined, 0, t)).toEqual({});
    });

    it('names the command asking for Keychain access', () => {
        const { keychain } = sessionSignalPresentation(
            { keychainPrompt: { command: 'node cli.js list', pid: 7, since: 0 } },
            0,
            t,
        );
        expect(keychain?.label).toBe('primarySidebar.signal.keychain.label');
        expect(keychain?.sentence).toContain('node cli.js list');
    });

    it('falls back to a generic sentence when the command is unknown', () => {
        expect(
            sessionSignalPresentation({ keychainPrompt: { command: '', pid: 7, since: 0 } }, 0, t)
                .keychain?.sentence,
        ).toBe('primarySidebar.signal.keychain.sentenceUnknown');
    });

    it('counts whole minutes of heat, at least one', () => {
        const heat = { cpuPercent: 190, since: 0 };
        expect(sessionSignalPresentation({ heat }, 30_000, t).heat?.sentence).toContain(
            '"minutes":1',
        );
        expect(sessionSignalPresentation({ heat }, 185_000, t).heat?.sentence).toContain(
            '"minutes":3',
        );
        expect(sessionSignalPresentation({ heat }, 0, t).heat?.sentence).toContain('"cpu":"190%"');
    });
});
