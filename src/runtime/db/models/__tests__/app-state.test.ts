import { describe, expect, it } from 'vitest';

import { parseAppStateValue } from '../app-state';

describe('parseAppStateValue', () => {
    it('rejects malformed JSON instead of asserting a domain type', () => {
        expect(() => parseAppStateValue('schemaVersion', '{')).toThrow(
            expect.objectContaining({ code: 'VALIDATION' }) as Error,
        );
    });

    it('rejects a well-formed value that does not match the key schema', () => {
        expect(() => parseAppStateValue('schemaVersion', '"not-a-number"')).toThrow(
            expect.objectContaining({ code: 'VALIDATION' }) as Error,
        );
        expect(() => parseAppStateValue('lastSelectedProjectId', '12')).toThrow(
            expect.objectContaining({ code: 'VALIDATION' }) as Error,
        );
        expect(() => parseAppStateValue('windowState', '{"isMaximized":"yes"}')).toThrow(
            expect.objectContaining({ code: 'VALIDATION' }) as Error,
        );
    });

    it('returns the parsed value when the cell matches the key schema', () => {
        expect(parseAppStateValue('schemaVersion', '7')).toBe(7);
        expect(parseAppStateValue('lastSelectedSessionId', 'null')).toBeNull();
        expect(
            parseAppStateValue('windowState', '{"isMaximized":false,"isFullScreen":true}'),
        ).toEqual({ isMaximized: false, isFullScreen: true });
    });
});
