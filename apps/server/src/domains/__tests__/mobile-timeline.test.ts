import { describe, expect, it, vi } from 'vitest';

import type { AgentTimelineService } from '../agents/timeline';
import type { AgentTranscriptWatcher } from '../agents/transcript-watcher';
import type { ConfigService } from '../config';
import type { CaxriDatabase } from '../db';
import { createMobileDomainHandlers } from '../mobile-handlers';
import type { MobileTerminalMutationQueue } from '../mobile-terminal-mutation-queue';
import type { TerminalManager } from '../terminal';

describe('mobile timeline authorization', () => {
    it('rejects another Project before reading or watching a transcript', async () => {
        const read = vi.fn();
        const watchMobile = vi.fn();
        const handlers = createMobileDomainHandlers({
            configuration: {} as ConfigService,
            database: {
                getSession: () => ({
                    id: 'session-other',
                    projectId: 'project-other',
                    primaryAgentTerminalId: 'terminal-other',
                }),
                listVisibleProjects: () => [{ id: 'project-other' }],
            } as unknown as CaxriDatabase,
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
    });

    it('distinguishes a Shell-only Session from a Session without an Agent or Terminal', async () => {
        let terminals: Array<{ kind: 'shell' }> = [{ kind: 'shell' }];
        const handlers = createMobileDomainHandlers({
            configuration: {} as ConfigService,
            database: {
                getSession: () => ({ id: 'session-fixture', projectId: 'project-granted' }),
                listVisibleProjects: () => [{ id: 'project-granted' }],
                listTerminals: () => terminals,
            } as unknown as CaxriDatabase,
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
});
