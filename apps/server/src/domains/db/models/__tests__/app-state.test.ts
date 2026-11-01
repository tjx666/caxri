import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabaseConnection as CaxriDatabase } from '../../index';
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

describe('AppStateModel.set', () => {
    const temporaryDirectories: string[] = [];

    afterEach(async () => {
        const directoriesToRemove = [...temporaryDirectories];
        temporaryDirectories.length = 0;
        await Promise.all(
            directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
        );
    });

    it('rejects a value past its schema bound and keeps the previous cell readable', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-app-state-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        try {
            const stored = { stoppedAt: 1, sessions: [] };
            database.appState.set('quitStoppedSessions', stored);
            const overCap = {
                stoppedAt: 2,
                sessions: Array.from({ length: 1_001 }, (_, index) => ({
                    sessionId: `session-${index}`,
                    terminalIds: [],
                    shouldContinue: false,
                })),
            };

            expect(() => database.appState.set('quitStoppedSessions', overCap)).toThrow(
                expect.objectContaining({ code: 'VALIDATION' }) as Error,
            );
            expect(database.appState.get('quitStoppedSessions')).toEqual(stored);
        } finally {
            database.close();
        }
    });
});
