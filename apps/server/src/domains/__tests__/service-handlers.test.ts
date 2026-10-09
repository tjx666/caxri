import { describe, expect, it, vi } from 'vitest';

import type { ConfigService } from '../config';
import type { CaxriDatabase } from '../db';
import type { DiagnosticsService } from '../diagnostics';
import { ExternalStatusHub } from '../external-status';
import type { FileService } from '../files';
import type { GitService } from '../git';
import { currentGitRequestSignal } from '../git/request-signal';
import type { createIntrospectionServices } from '../introspection';
import type { ProjectStatusService } from '../project-status';
import { VercelDeploymentStore } from '../project-status';
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
            agentChat: {} as never,
            agentEnvironment: {} as never,
            agentHooks: {} as never,
            awaitAgentSettingsReconcile: () => Promise.resolve(),
            commander: {} as never,
            configuration: {} as ConfigService,
            database: {} as CaxriDatabase,
            diagnostics: {} as DiagnosticsService,
            emit: () => {},
            externalStatus: new ExternalStatusHub(),
            files: {} as FileService,
            git: { sync } as unknown as GitService,
            introspection: {} as ReturnType<typeof createIntrospectionServices>,
            logger: {} as never,
            longPastes: {} as never,
            projectStatus: { useSessionPullRequests: () => {} } as unknown as ProjectStatusService,
            sessionContext: {} as never,
            terminals: {} as never,
            timeline: {} as never,
            transcripts: {} as never,
            userDataPath: '/tmp/caxri-runtime-handler-test',
            vercel: new VercelDeploymentStore(new ExternalStatusHub().run),
        });

        await handlers['git.sync'](
            { repositoryId: 'repository-1', sessionId: 'session-1' },
            controller.signal,
        );

        expect(sync).toHaveBeenCalledOnce();
        expect(observedSignal).toBe(controller.signal);
    });
});

describe('Theme import handler', () => {
    it('does not change the active theme when the imported theme is rejected', async () => {
        const failure = new Error('No supported colors');
        const importTheme = vi.fn().mockRejectedValue(failure);
        const setAppState = vi.fn();
        const handlers = createServiceHandlers({
            acknowledgeFileMutation: () => Promise.resolve(),
            agentChat: {} as never,
            agentEnvironment: {} as never,
            agentHooks: {} as never,
            awaitAgentSettingsReconcile: () => Promise.resolve(),
            commander: {} as never,
            configuration: { importTheme } as unknown as ConfigService,
            database: { setAppState } as unknown as CaxriDatabase,
            diagnostics: {} as DiagnosticsService,
            emit: () => {},
            externalStatus: new ExternalStatusHub(),
            files: {} as FileService,
            git: {} as GitService,
            introspection: {} as ReturnType<typeof createIntrospectionServices>,
            logger: {} as never,
            longPastes: {} as never,
            projectStatus: { useSessionPullRequests: () => {} } as unknown as ProjectStatusService,
            sessionContext: {} as never,
            terminals: {} as never,
            timeline: {} as never,
            transcripts: {} as never,
            userDataPath: '/tmp/caxri-theme-import-handler-test',
            vercel: new VercelDeploymentStore(new ExternalStatusHub().run),
        });

        await expect(handlers['theme.importPath']({ path: '/tmp/empty-theme.json' })).rejects.toBe(
            failure,
        );
        expect(importTheme).toHaveBeenCalledWith('/tmp/empty-theme.json');
        expect(setAppState).not.toHaveBeenCalled();
    });
});
