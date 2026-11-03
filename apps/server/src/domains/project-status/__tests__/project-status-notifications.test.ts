import type { ServerEvent } from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProjectStatusService } from '..';
import {
    checkPayload,
    cleanupProjectStatusFixtures,
    githubOnlyRunner,
    gitSummary,
    logger,
} from './project-status.fixture';

afterEach(cleanupProjectStatusFixtures);

describe('ProjectStatusService notifications', () => {
    it('emits a delivery alert when a check turns into a failure', async () => {
        let conclusion = 'SUCCESS';
        const emitted = vi.fn<(event: ServerEvent) => void>();
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary) },
            await logger(),
            githubOnlyRunner(() => checkPayload({ name: 'unit', conclusion })),
            { emit: emitted, settings: () => defaultAppSettings },
        );

        await service.summary('session-1');
        await vi.waitFor(() => expect(emitted).toHaveBeenCalled());
        conclusion = 'FAILURE';
        await service.summary('session-1', 'refresh-1');

        const alerts = (): ServerEvent[] =>
            emitted.mock.calls
                .map(([event]) => event)
                .filter((event) => event.event === 'projectStatus.alert');
        await vi.waitFor(() =>
            expect(alerts()).toEqual([
                {
                    event: 'projectStatus.alert',
                    payload: {
                        sessionId: 'session-1',
                        kind: 'check',
                        repository: 'project',
                        branch: 'feature/status',
                        name: 'unit',
                        // No `detailsUrl`, so the alert falls back to the pull request itself.
                        url: 'https://github.com/example/project/pull/7',
                    },
                },
            ]),
        );
    });

    it('tells the merge listener when a refresh sees a pull request turn merged', async () => {
        let state = 'OPEN';
        const emitted = vi.fn<(event: ServerEvent) => void>();
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary) },
            await logger(),
            githubOnlyRunner(() => ({
                ...(checkPayload({ name: 'unit', conclusion: 'SUCCESS' }) as object),
                state,
                ...(state === 'MERGED' && { mergedAt: new Date().toISOString() }),
            })),
            { emit: emitted, settings: () => defaultAppSettings },
        );
        const merged =
            vi.fn<(sessionId: string, merge: { mergedAt?: number; url: string }) => void>();
        service.useMergeListener(merged);

        await service.summary('session-1');
        await vi.waitFor(() => expect(emitted).toHaveBeenCalled());
        expect(merged).not.toHaveBeenCalled();
        state = 'MERGED';
        await service.summary('session-1', 'refresh-1');

        await vi.waitFor(() => expect(merged).toHaveBeenCalledOnce());
        const [sessionId, merge] = merged.mock.calls[0];
        expect(sessionId).toBe('session-1');
        expect(merge.url).toBe('https://github.com/example/project/pull/7');
        // `mergedAt` is what lets the notice skip a merge the Agent made itself.
        expect(merge.mergedAt).toBeTypeOf('number');
    });

    it('keeps the alert baseline current while notifications are disabled, and stays silent', async () => {
        let conclusion = 'SUCCESS';
        const emitted = vi.fn<(event: ServerEvent) => void>();
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary) },
            await logger(),
            githubOnlyRunner(() => checkPayload({ name: 'unit', conclusion })),
            {
                emit: emitted,
                settings: () => ({
                    ...defaultAppSettings,
                    'projectStatus.notifications.enabled': false,
                }),
            },
        );

        await service.summary('session-1');
        await vi.waitFor(() => expect(emitted).toHaveBeenCalled());
        conclusion = 'FAILURE';
        await service.summary('session-1', 'refresh-1');
        await vi.waitFor(() => expect(emitted).toHaveBeenCalledTimes(2));

        expect(emitted.mock.calls.some(([event]) => event.event === 'projectStatus.alert')).toBe(
            false,
        );
    });
});
