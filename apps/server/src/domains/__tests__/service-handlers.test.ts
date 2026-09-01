import { describe, expect, it, vi } from 'vitest';

import type { ConfigService } from '../config';
import type { CaxriDatabase } from '../db';
import type { DiagnosticsService } from '../diagnostics';
import type { FileService } from '../files';
import type { GitService } from '../git';
import { currentGitRequestSignal } from '../git/request-signal';
import type { createIntrospectionServices } from '../introspection';
import type { ProjectStatusService } from '../project-status';
import { createServiceHandlers } from '../service-handlers';

describe('Runtime service handler cancellation', () => {
    it('binds git.sync to the admitted Runtime request signal', async () => {
        const controller = new AbortController();
        let observedSignal: AbortSignal | undefined;
        const sync = vi.fn(() => {
            observedSignal = currentGitRequestSignal();
            return Promise.resolve(null);
        });
        const handlers = createServiceHandlers({
            acknowledgeFileMutation: () => Promise.resolve(),
            agentEnvironment: {} as never,
            agentHooks: {} as never,
            awaitAgentSettingsReconcile: () => Promise.resolve(),
            configuration: {} as ConfigService,
            database: {} as CaxriDatabase,
            diagnostics: {} as DiagnosticsService,
            emit: () => {},
            files: {} as FileService,
            git: { sync } as unknown as GitService,
            introspection: {} as ReturnType<typeof createIntrospectionServices>,
            longPastes: {} as never,
            projectStatus: {} as ProjectStatusService,
            transcripts: {} as never,
            userDataPath: '/tmp/caxri-runtime-handler-test',
        });

        await handlers['git.sync'](
            { repositoryId: 'repository-1', sessionId: 'session-1' },
            controller.signal,
        );

        expect(sync).toHaveBeenCalledOnce();
        expect(observedSignal).toBe(controller.signal);
    });
});
