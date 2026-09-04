import type { Mock } from 'vitest';
import { vi } from 'vitest';

export interface SuperviseModuleMock {
    connectDesktopToServer: Mock;
    ensureServer: Mock;
    resolveServerArtifact: Mock;
    ServerArtifactSupervisor: Mock;
}

/**
 * Module factory for `vi.mock('@caxri/client/supervise', ...)`, kept in its own file with no import of the mocked
 * module. `vi.mock` is hoisted above every static import, so a factory reached through an ordinary import is still
 * uninitialized when the mocked module is first requested; test files pull this in through `vi.hoisted` instead. The
 * wider fixture set in `server-connection-harness.ts` cannot host it, because that file imports the mocked module
 * itself and would recurse through the factory while still evaluating.
 */
export function superviseModuleMock(): SuperviseModuleMock {
    return {
        connectDesktopToServer: vi.fn(),
        ensureServer: vi.fn(),
        ServerArtifactSupervisor: vi.fn(),
        resolveServerArtifact: vi.fn(() =>
            Promise.resolve({
                bundleDirectory: '/app/server/bundles',
                entryPath: '/app/server/bundles/server-core.js',
                executablePath: '/app/server/runtime/bin/node',
                manifest: {},
                rootPath: '/app/server',
            }),
        ),
    };
}
