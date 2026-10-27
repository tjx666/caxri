import { describe, expect, it } from 'vitest';

import { parseAppStateValue } from '../app-state';

describe('parseAppStateValue', () => {
    it('rejects malformed JSON instead of asserting a domain type', () => {
        expect(() => parseAppStateValue('activeThemeId', '{')).toThrow(
            expect.objectContaining({ code: 'VALIDATION' }) as Error,
        );
    });

    it('rejects a well-formed value that does not match the key schema', () => {
        expect(() => parseAppStateValue('activeThemeId', '""')).toThrow(
            expect.objectContaining({ code: 'VALIDATION' }) as Error,
        );
        expect(() => parseAppStateValue('lastSelectedProjectId', '12')).toThrow(
            expect.objectContaining({ code: 'VALIDATION' }) as Error,
        );
        expect(() => parseAppStateValue('windowState', '{"isMaximized":"yes"}')).toThrow(
            expect.objectContaining({ code: 'VALIDATION' }) as Error,
        );
        expect(() =>
            parseAppStateValue('auxiliaryWindowState', '{"caxriBot":{"wasOpenAtQuit":"yes"}}'),
        ).toThrow(expect.objectContaining({ code: 'VALIDATION' }) as Error);
    });

    it('rejects a window key that is not a plain identifier', () => {
        expect(() =>
            parseAppStateValue(
                'openSessionsByWindow',
                '{"bad key":{"openSessionIds":[],"activeSessionId":null}}',
            ),
        ).toThrow(expect.objectContaining({ code: 'VALIDATION' }) as Error);
    });

    it('returns the parsed value when the cell matches the key schema', () => {
        expect(parseAppStateValue('activeThemeId', '"caxri.dark"')).toBe('caxri.dark');
        expect(
            parseAppStateValue(
                'openSessionsByWindow',
                '{"main":{"openSessionIds":["a","b"],"activeSessionId":"b"}}',
            ),
        ).toEqual({ main: { openSessionIds: ['a', 'b'], activeSessionId: 'b' } });
        expect(
            parseAppStateValue('windowState', '{"isMaximized":false,"isFullScreen":true}'),
        ).toEqual({ isMaximized: false, isFullScreen: true });
        expect(
            parseAppStateValue(
                'auxiliaryWindowState',
                '{"caxriBot":{"wasOpenAtQuit":true},"processExplorer":{}}',
            ),
        ).toEqual({ caxriBot: { wasOpenAtQuit: true }, processExplorer: {} });
    });
});
