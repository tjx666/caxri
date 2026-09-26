import { MOBILE_FILES_MAX_ENTRIES, MOBILE_FILES_READ_MAX_BYTES } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { AgentTimelineService } from '../../agents/timeline';
import type { AgentTranscriptWatcher } from '../../agents/transcript-watcher';
import type { ConfigService } from '../../config';
import type { CaxriDatabase } from '../../db';
import type { FileService } from '../../files';
import type { GitService } from '../../git';
import { createMobileDomainHandlers } from '../handlers';
import type { MobileTerminalMutationQueue } from '../../mobile-terminal-mutation-queue';
import type { TerminalManager } from '../../terminal';

const principal = {
    kind: 'paired-device' as const,
    id: 'paired-device:fixture',
    deviceId: 'fixture',
    generation: 1,
    role: 'view' as const,
    projectIds: ['project-granted'],
};

const handlersWith = (files: Partial<FileService>) =>
    createMobileDomainHandlers({
        configuration: {} as ConfigService,
        emit: vi.fn(),
        files: files as FileService,
        database: {
            getSession: () => ({ id: 'session-granted', projectId: 'project-granted' }),
            listVisibleProjects: () => [{ id: 'project-granted' }],
        } as unknown as CaxriDatabase,
        git: {} as GitService,
        queue: {} as MobileTerminalMutationQueue,
        terminals: {} as TerminalManager,
        timeline: {} as AgentTimelineService,
        transcripts: {} as AgentTranscriptWatcher,
    });

describe('mobile read-only files', () => {
    it('truncates a directory larger than one mobile reply instead of failing', async () => {
        const entries = Array.from({ length: MOBILE_FILES_MAX_ENTRIES + 10 }, (_, index) => ({
            name: `file-${index}.txt`,
            path: `/workspace/file-${index}.txt`,
            kind: 'file' as const,
        }));
        const handlers = handlersWith({
            listDirectory: vi.fn(() => Promise.resolve({ entries, truncated: false })),
        });
        const result = await handlers['mobile.files.listInternal']({
            sessionId: 'session-granted',
            principal,
        });
        expect(result.entries).toHaveLength(MOBILE_FILES_MAX_ENTRIES);
        expect(result.truncated).toBe(true);
    });

    it('reports a file above the mobile reply limit as oversized', async () => {
        const handlers = handlersWith({
            read: vi.fn(() =>
                Promise.resolve({
                    path: '/workspace/large.txt',
                    content: 'x'.repeat(MOBILE_FILES_READ_MAX_BYTES + 1),
                    mtimeMs: 1,
                    size: MOBILE_FILES_READ_MAX_BYTES + 1,
                }),
            ),
        });
        await expect(
            handlers['mobile.files.readInternal']({
                sessionId: 'session-granted',
                path: '/workspace/large.txt',
                principal,
            }),
        ).resolves.toEqual({ status: 'oversized' });
    });
});
