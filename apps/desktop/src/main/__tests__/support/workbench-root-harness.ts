import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Mock } from 'vitest';
import { afterEach } from 'vitest';

import { ProjectRootGrants } from '../../root-grants';
import type { DesktopServerConnection } from '../../server-connection';
import { createWorkbenchRootAuthority } from '../../workbench-root-authority';

export interface ElectronDialogMock {
    showMessageBox: Mock;
    showOpenDialog: Mock;
}

/**
 * The shared rig for the `workbench-root-authority` suites, which are split by surface but all drive the one factory.
 * The Electron dialog mock is passed in rather than created here: `vi.mock` is hoisted to the top of the file that
 * calls it, so each suite has to declare its own with `vi.hoisted`.
 */
export function workbenchRootHarness(dialog: ElectronDialogMock) {
    const temporaryDirectories: string[] = [];

    /**
     * Returns the realpath-canonicalized directory so assertions can compare it directly against the canonical paths
     * `workbench-root-authority` produces; on macOS `tmpdir()` itself is a symlink (`/var` -> `/private/var`), so the
     * raw `mkdtemp` result would never match.
     */
    async function temporaryDirectory(prefix = 'caxri-workbench-root-'): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        temporaryDirectories.push(path);
        return realpath(path);
    }

    afterEach(async () => {
        dialog.showMessageBox.mockReset();
        dialog.showOpenDialog.mockReset();
        const directoriesToRemove = temporaryDirectories.slice();
        temporaryDirectories.length = 0;
        await Promise.all(
            directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
        );
    });

    function server(request: (method: string, parameters?: unknown) => Promise<unknown>) {
        return { request } as unknown as DesktopServerConnection;
    }

    const unusedServer = server(() =>
        Promise.reject(new Error('Server was not expected to be called')),
    );

    function authority(options: {
        getServer?: DesktopServerConnection;
        grants?: ProjectRootGrants;
        nextTestRoot?: () => string | undefined;
        window?: object;
    }) {
        const grants = options.grants ?? new ProjectRootGrants();
        return {
            grants,
            instance: createWorkbenchRootAuthority({
                getServer: () => options.getServer ?? unusedServer,
                getWindow: () => options.window as never,
                grants,
                // These suites do not assert on path-browser logging; `path-browser-authority.fixture.ts` covers that.
                logger: () => {},
                nextTestRoot: options.nextTestRoot ?? (() => {}),
            }),
        };
    }

    return { authority, server, temporaryDirectory };
}
