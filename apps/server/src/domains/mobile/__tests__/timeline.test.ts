import { describe, expect, it, vi } from 'vitest';

import type { AgentTimelineService } from '../../agents/timeline';
import type { AgentTranscriptWatcher } from '../../agents/transcript-watcher';
import type { ConfigService } from '../../config';
import type { CaxriDatabase } from '../../db';
import type { FileService } from '../../files';
import type { GitService } from '../../git';
import type { TerminalManager } from '../../terminal';
import { createMobileDomainHandlers } from '../handlers';
import type { MobileTerminalMutationQueue } from '../terminal-mutation-queue';

describe('mobile timeline authorization', () => {
    it('lets a view-role device read changes only through its granted Session', async () => {
        const mobileChangesList = vi.fn(() =>
            Promise.resolve({
                isRepository: true,
                files: [],
                total: 0,
                additions: 0,
                deletions: 0,
                truncated: false,
            }),
        );
        const mobileChangesDiff = vi.fn(() => Promise.resolve({ status: 'stale' as const }));
        const handlers = createMobileDomainHandlers({
            configuration: {} as ConfigService,
            emit: vi.fn(),
            files: {} as FileService,
            database: {
                getSession: () => ({ id: 'session-granted', projectId: 'project-granted' }),
                listVisibleProjects: () => [{ id: 'project-granted' }],
            } as unknown as CaxriDatabase,
            git: { mobileChangesList, mobileChangesDiff } as unknown as GitService,
            queue: {} as MobileTerminalMutationQueue,
            terminals: {} as TerminalManager,
            timeline: {} as AgentTimelineService,
            transcripts: {} as AgentTranscriptWatcher,
        });
        const principal = {
            kind: 'paired-device' as const,
            id: 'paired-device:fixture',
            deviceId: 'fixture',
            generation: 1,
            role: 'view' as const,
            projectIds: ['project-granted'],
        };
        await expect(
            handlers['mobile.changes.listInternal']({
                sessionId: 'session-granted',
                refresh: true,
                principal,
            }),
        ).resolves.toMatchObject({ isRepository: true });
        await expect(
            handlers['mobile.changes.diffInternal']({
                sessionId: 'session-granted',
                repositoryId: 'repository-granted',
                path: 'file.txt',
                principal,
            }),
        ).resolves.toEqual({ status: 'stale' });
        expect(mobileChangesList).toHaveBeenCalledWith('session-granted', true);
        expect(mobileChangesDiff).toHaveBeenCalledWith(
            'session-granted',
            'repository-granted',
            'file.txt',
        );
    });

    it('rejects another Project before reading or watching a transcript', async () => {
        const read = vi.fn();
        const watchMobile = vi.fn();
        const mobileChangesList = vi.fn();
        const mobileChangesDiff = vi.fn();
        const handlers = createMobileDomainHandlers({
            configuration: {} as ConfigService,
            emit: vi.fn(),
            files: {} as FileService,
            database: {
                getSession: () => ({
                    id: 'session-other',
                    projectId: 'project-other',
                    primaryAgentTerminalId: 'terminal-other',
                }),
                listVisibleProjects: () => [{ id: 'project-other' }],
            } as unknown as CaxriDatabase,
            git: { mobileChangesList, mobileChangesDiff } as unknown as GitService,
            queue: {} as MobileTerminalMutationQueue,
            terminals: {} as TerminalManager,
            timeline: { read } as unknown as AgentTimelineService,
            transcripts: { watchMobile } as unknown as AgentTranscriptWatcher,
        });
        const principal = {
            kind: 'paired-device' as const,
            id: 'paired-device:fixture',
            deviceId: 'fixture',
            generation: 1,
            role: 'view' as const,
            projectIds: ['project-granted'],
        };
        await expect(
            handlers['mobile.timeline.readInternal']({
                sessionId: 'session-other',
                limit: 40,
                principal,
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(
            handlers['mobile.timeline.watchInternal']({
                sessionId: 'session-other',
                principal,
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(read).not.toHaveBeenCalled();
        expect(watchMobile).not.toHaveBeenCalled();
        expect(() =>
            handlers['mobile.changes.listInternal']({
                sessionId: 'session-other',
                refresh: false,
                principal,
            }),
        ).toThrow('Session not found');
        expect(() =>
            handlers['mobile.changes.diffInternal']({
                sessionId: 'session-other',
                repositoryId: 'repository-other',
                path: 'file.txt',
                principal,
            }),
        ).toThrow('Session not found');
        expect(mobileChangesList).not.toHaveBeenCalled();
        expect(mobileChangesDiff).not.toHaveBeenCalled();
    });

    it('distinguishes a Shell-only Session from a Session without an Agent or Terminal', async () => {
        let terminals: Array<{ kind: 'shell' }> = [{ kind: 'shell' }];
        const handlers = createMobileDomainHandlers({
            configuration: {} as ConfigService,
            emit: vi.fn(),
            files: {} as FileService,
            database: {
                getSession: () => ({ id: 'session-fixture', projectId: 'project-granted' }),
                listVisibleProjects: () => [{ id: 'project-granted' }],
                listTerminals: () => terminals,
            } as unknown as CaxriDatabase,
            git: {} as GitService,
            queue: {} as MobileTerminalMutationQueue,
            terminals: {} as TerminalManager,
            timeline: { read: vi.fn() } as unknown as AgentTimelineService,
            transcripts: {} as AgentTranscriptWatcher,
        });
        const principal = {
            kind: 'paired-device' as const,
            id: 'paired-device:fixture',
            deviceId: 'fixture',
            generation: 1,
            role: 'view' as const,
            projectIds: ['project-granted'],
        };
        await expect(
            handlers['mobile.timeline.readInternal']({
                sessionId: 'session-fixture',
                limit: 40,
                principal,
            }),
        ).resolves.toMatchObject({ status: 'unsupported' });
        terminals = [];
        await expect(
            handlers['mobile.timeline.readInternal']({
                sessionId: 'session-fixture',
                limit: 40,
                principal,
            }),
        ).resolves.toMatchObject({ status: 'missing' });
    });

    it('reads one Terminal message in slices through the granted Session only', async () => {
        const text = 'x'.repeat(20_000);
        const readMessage = vi.fn((_session: string, _terminal: string, itemId: string) =>
            Promise.resolve(itemId === 'item-1' ? text : undefined),
        );
        const handlers = createMobileDomainHandlers({
            configuration: {} as ConfigService,
            emit: vi.fn(),
            files: {} as FileService,
            database: {
                getSession: (id: string) =>
                    id === 'session-granted'
                        ? {
                              id,
                              projectId: 'project-granted',
                              primaryAgentTerminalId: 'terminal-1',
                          }
                        : { id, projectId: 'project-other', primaryAgentTerminalId: 'terminal-2' },
                listVisibleProjects: () => [{ id: 'project-granted' }, { id: 'project-other' }],
            } as unknown as CaxriDatabase,
            git: {} as GitService,
            queue: {} as MobileTerminalMutationQueue,
            terminals: {} as TerminalManager,
            timeline: { readMessage } as unknown as AgentTimelineService,
            transcripts: {} as AgentTranscriptWatcher,
        });
        const principal = {
            kind: 'paired-device' as const,
            id: 'paired-device:fixture',
            deviceId: 'fixture',
            generation: 1,
            role: 'view' as const,
            projectIds: ['project-granted'],
        };
        const read = (sessionId: string, itemId: string, offset: number) =>
            handlers['mobile.timeline.readMessageInternal']({
                sessionId,
                itemId,
                offset,
                principal,
            });
        await expect(read('session-granted', 'item-1', 0)).resolves.toMatchObject({
            totalLength: 20_000,
            nextOffset: 16_000,
        });
        await expect(read('session-granted', 'item-1', 16_000)).resolves.toEqual({
            text: 'x'.repeat(4_000),
            totalLength: 20_000,
        });
        await expect(read('session-granted', 'gone', 0)).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
        await expect(read('session-other', 'item-1', 0)).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
        expect(readMessage).not.toHaveBeenCalledWith('session-other', 'terminal-2', 'item-1');
    });
});
