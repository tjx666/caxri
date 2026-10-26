import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Locks the Renderer-facing authority surface of the workbench preload. When this fails, a global or bridge method was
 * added or removed: update the exposed-globals list in `.agents/skills/project-architecture/references/ipc.md` (and
 * `security.md` for test seams) in the same change.
 */
const electronMock = vi.hoisted(() => ({
    exposed: new Map<string, unknown>(),
}));

vi.mock('electron', () => ({
    contextBridge: {
        exposeInMainWorld: (key: string, value: unknown) => electronMock.exposed.set(key, value),
    },
    ipcRenderer: {
        invoke: vi.fn(),
        off: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
        send: vi.fn(),
    },
    webUtils: { getPathForFile: vi.fn() },
}));

const bridgeMethods = [
    'negotiate',
    'onEvent',
    'pathForFile',
    'reportDiagnostic',
    'reportError',
    'request',
    'requestWithId',
];

const byName = (left: string, right: string) => left.localeCompare(right);

async function loadPreload(): Promise<void> {
    electronMock.exposed.clear();
    vi.resetModules();
    await import('../index');
}

describe('workbench preload exposed surface', () => {
    beforeEach(() => {
        vi.stubEnv('CAXRI_WORKTREE_PATH', '');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('exposes only the documented globals without CAXRI_E2E', async () => {
        vi.stubEnv('CAXRI_E2E', '');
        await loadPreload();

        expect(electronMock.exposed.keys().toArray().toSorted(byName)).toEqual([
            'caxri',
            'performanceMonitorHost',
        ]);
        expect(Object.keys(electronMock.exposed.get('caxri') as object).toSorted(byName)).toEqual(
            bridgeMethods,
        );
        expect(
            Object.keys(electronMock.exposed.get('performanceMonitorHost') as object).toSorted(
                byName,
            ),
        ).toEqual(['isActive', 'onControl', 'publish']);
    });

    it('adds the worktree marker and E2E bridge only when their variables are set', async () => {
        vi.stubEnv('CAXRI_E2E', '1');
        vi.stubEnv('CAXRI_WORKTREE_PATH', '/tmp/worktree');
        await loadPreload();

        expect(electronMock.exposed.keys().toArray().toSorted(byName)).toEqual([
            '__caxriWorktree',
            'caxri',
            'caxriE2E',
            'performanceMonitorHost',
        ]);
        expect(Object.keys(electronMock.exposed.get('caxri') as object).toSorted(byName)).toEqual(
            bridgeMethods,
        );
    });
});
