import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, vi } from 'vitest';

import type { DesktopServerConnection } from '../../connection/server-connection';
import type { PathBrowserOpenTarget } from '../authority';
import { createPathBrowserAuthority } from '../authority';
import type { PathBrowserLogger } from '../log';

/**
 * Registers the shared cleanup hook and returns the temporary-directory creator bound to it, so every path-browser
 * suite gets one cleanup contract without this module running a hook at import time.
 */
export function registerTemporaryDirectories(): (prefix: string) => Promise<string> {
    const temporaryDirectories: string[] = [];
    afterEach(async () => {
        const directoriesToRemove = [...temporaryDirectories];
        temporaryDirectories.length = 0;
        await Promise.all(
            directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
        );
    });
    return async (prefix) => {
        const path = await mkdtemp(join(tmpdir(), prefix));
        temporaryDirectories.push(path);
        return path;
    };
}

function server(request: (method: string, parameters?: unknown) => Promise<unknown>) {
    return { request } as unknown as DesktopServerConnection;
}

export function bootstrap(ownerRoot: string, workbenchRoot: string) {
    return {
        projects: [
            { id: 'project-owner', title: 'Owner', rootPath: ownerRoot },
            { id: 'project-worktree', title: 'Worktree', rootPath: workbenchRoot },
        ],
        sessions: [
            {
                id: 'session-1',
                archivedAt: undefined,
                projectId: 'project-owner',
                workbenchRootProjectId: 'project-worktree',
            },
        ],
        selectedSessionId: 'session-1',
    };
}

/**
 * Records every `write()` call verbatim so a test can assert on the exact event/level/fields a fallback or a search
 * failure produced, rather than only on whether logging happened at all.
 */
export function fakeLogger(): PathBrowserLogger & {
    calls: Array<Parameters<PathBrowserLogger['write']>>;
} {
    const calls: Array<Parameters<PathBrowserLogger['write']>> = [];
    return {
        calls,
        write: (...call) => {
            calls.push(call);
        },
    };
}

export function authorityOptions(
    ownerRoot: string,
    workbenchRoot: string,
    options: {
        logger?: PathBrowserLogger;
        openFile?: (
            target: PathBrowserOpenTarget,
        ) => Promise<{ canceled: true } | { opened: true }>;
        request?: (method: string, parameters?: unknown) => Promise<unknown>;
        userHome?: string;
    } = {},
) {
    const request = vi.fn(
        options.request ??
            ((method: string) => {
                if (method === 'app.bootstrap')
                    return Promise.resolve(bootstrap(ownerRoot, workbenchRoot));
                if (method === 'files.browse')
                    return Promise.resolve({ entries: [], truncated: false });
                return Promise.reject(new Error(`Unexpected method: ${method}`));
            }),
    );
    const openFile = vi.fn(options.openFile ?? (() => Promise.resolve({ opened: true as const })));
    return {
        authority: createPathBrowserAuthority({
            getServer: () => server(request),
            logger: () => options.logger,
            openFile,
            ...(options.userHome && { userHome: options.userHome }),
        }),
        openFile,
        request,
    };
}
