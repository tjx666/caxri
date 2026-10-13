import type { DragEvent } from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { useEnvironmentStore } from '../stores/environment';
import {
    dragPath,
    FILE_TREE_DRAG_TYPE,
    hasDraggedPath,
    hasTerminalDraggedPath,
    isOsFileReferenceRefused,
    osFilePaths,
    PROJECT_PATH_DRAG_TYPE,
    projectTerminalInput,
    shellRelativePath,
    startFilePathDrag,
    terminalDragPaths,
    terminalInputPath,
    terminalReferencePath,
} from './file-drag';

/**
 * The suite runs under Vitest's `node` environment (no jsdom, see `vitest.config.ts`), so a real
 * `DataTransfer`/`DragEvent` does not exist. Both helpers only ever touch `event.dataTransfer`, so a minimal fake
 * covering `getData` and `types` is enough to drive them deterministically.
 */
function fakeDragEvent(data: Record<string, string>): DragEvent {
    return {
        dataTransfer: {
            getData: (type: string) => data[type] ?? '',
            types: Object.keys(data),
        },
    } as unknown as DragEvent;
}

describe('dragPath', () => {
    it('keeps Project roots absolute and separate from Files move payloads', () => {
        const event = fakeDragEvent({ [PROJECT_PATH_DRAG_TYPE]: "/repo/a 'quoted' folder" });
        expect(projectTerminalInput(event.dataTransfer)).toBe(
            String.raw`'/repo/a '\''quoted'\'' folder'`,
        );
        expect(hasDraggedPath(event)).toBe(false);
        expect(dragPath(event)).toBeUndefined();
        expect(projectTerminalInput(fakeDragEvent({}).dataTransfer)).toBeUndefined();
    });
    it('reads back the path stored under the custom MIME type', () => {
        const event = fakeDragEvent({ [FILE_TREE_DRAG_TYPE]: '/repo/src/index.ts' });

        expect(dragPath(event)).toBe('/repo/src/index.ts');
    });

    it('returns undefined when the custom MIME type carries no path', () => {
        const event = fakeDragEvent({ 'text/plain': 'not a caxri drag' });

        expect(dragPath(event)).toBeUndefined();
    });

    it('returns undefined when the custom MIME type is present but empty', () => {
        const event = fakeDragEvent({ [FILE_TREE_DRAG_TYPE]: '' });

        expect(dragPath(event)).toBeUndefined();
    });
});

describe('hasDraggedPath', () => {
    it('is true when the drag carries the custom MIME type', () => {
        const event = fakeDragEvent({ [FILE_TREE_DRAG_TYPE]: '/repo/src/index.ts' });

        expect(hasDraggedPath(event)).toBe(true);
    });

    it('is false for an unrelated drag (e.g. dragging text or an external file)', () => {
        const event = fakeDragEvent({ 'text/plain': 'hello' });

        expect(hasDraggedPath(event)).toBe(false);
    });
});

describe('shellRelativePath', () => {
    it('makes a path inside the base directory relative', () => {
        expect(shellRelativePath('/repo/src/index.ts', '/repo')).toBe('src/index.ts');
        expect(shellRelativePath('/repo/src/index.ts', '/repo/')).toBe('src/index.ts');
    });

    it('spells the base directory itself as the current directory', () => {
        expect(shellRelativePath('/repo', '/repo')).toBe('.');
        expect(shellRelativePath('/repo/', '/repo')).toBe('.');
    });

    it('keeps paths outside the base and sibling-prefixed paths absolute', () => {
        expect(shellRelativePath('/other/file.ts', '/repo')).toBe('/other/file.ts');
        expect(shellRelativePath('/repo-two/file.ts', '/repo')).toBe('/repo-two/file.ts');
        expect(shellRelativePath('/repo/src/index.ts', '/repo/src/lib')).toBe('/repo/src/index.ts');
    });

    it('keeps the absolute path when no base directory is known', () => {
        expect(shellRelativePath('/repo/src/index.ts', undefined)).toBe('/repo/src/index.ts');
        expect(shellRelativePath('/repo/src/index.ts', '')).toBe('/repo/src/index.ts');
    });

    it('prefixes a relative path that would parse as a shell option', () => {
        expect(shellRelativePath('/repo/-rf', '/repo')).toBe('./-rf');
    });
});

describe('terminalInputPath', () => {
    it('keeps an ordinary absolute path readable', () => {
        expect(terminalInputPath('/repo/src/index.ts')).toBe('/repo/src/index.ts');
    });

    it('drops the Terminal working directory prefix and quotes the remainder when needed', () => {
        expect(terminalInputPath('/repo/src/index.ts', '/repo')).toBe('src/index.ts');
        expect(terminalInputPath("/repo/file with 'quote'.txt", '/repo')).toBe(
            String.raw`'file with '\''quote'\''.txt'`,
        );
    });

    it('quotes whitespace and shell metacharacters as one argument', () => {
        expect(terminalInputPath('/repo/a file;echo unsafe.txt')).toBe(
            "'/repo/a file;echo unsafe.txt'",
        );
    });

    it('closes and reopens the quote around an embedded single quote', () => {
        expect(terminalInputPath("/repo/file with 'quote'.txt")).toBe(
            String.raw`'/repo/file with '\''quote'\''.txt'`,
        );
    });
});

describe('Terminal file references', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('inserts a linked entry without making it a Files move source', () => {
        const data: Record<string, string> = {};
        const transfer = {
            effectAllowed: 'none',
            setData: (type: string, value: string) => {
                data[type] = value;
            },
        } as DataTransfer;
        startFilePathDrag(transfer, '/repo/linked folder', false);
        const event = fakeDragEvent(data);
        expect(transfer.effectAllowed).toBe('copy');
        expect(hasTerminalDraggedPath(event)).toBe(true);
        expect(terminalDragPaths(event)).toEqual(['/repo/linked folder']);
        expect(hasDraggedPath(event)).toBe(false);
        expect(dragPath(event)).toBeUndefined();
    });

    it('retains ordinary Files move and Terminal insertion payloads', () => {
        const data: Record<string, string> = {};
        const transfer = {
            effectAllowed: 'none',
            setData: (type: string, value: string) => {
                data[type] = value;
            },
        } as DataTransfer;
        startFilePathDrag(transfer, '/repo/file.txt', true);
        const event = fakeDragEvent(data);
        expect(transfer.effectAllowed).toBe('copyMove');
        expect(hasTerminalDraggedPath(event)).toBe(true);
        expect(terminalDragPaths(event)).toEqual(['/repo/file.txt']);
        expect(hasDraggedPath(event)).toBe(true);
    });

    it('resolves files from another application through the preload, leaving out those with no path', () => {
        vi.stubGlobal('caxri', {
            pathForFile: (file: { name: string }) =>
                file.name === 'promise.png' ? '' : `/Volumes/Shots/${file.name}`,
        });
        const event = {
            dataTransfer: {
                files: [{ name: 'one.png' }, { name: 'promise.png' }, { name: 'two three.png' }],
                getData: () => '',
                types: ['Files'],
            },
        } as unknown as DragEvent;

        expect(hasTerminalDraggedPath(event)).toBe(true);
        expect(terminalDragPaths(event)).toEqual([
            '/Volumes/Shots/one.png',
            '/Volumes/Shots/two three.png',
        ]);
    });

    it('resolves references against the verified Agent worktree before launch cwd', () => {
        const terminal = {
            cwd: '/repo',
            agentCwd: '/worktrees/task',
            lastAgentProcessState: 'running' as const,
        };
        expect(terminalReferencePath('/worktrees/task/src/file.ts', terminal)).toBe('src/file.ts');
        expect(terminalReferencePath('/worktrees/task/linked folder', terminal)).toBe(
            "'linked folder'",
        );
        expect(terminalReferencePath('/repo/src/file.ts', terminal)).toBe('/repo/src/file.ts');
        expect(terminalReferencePath('/repo/src/file.ts', { cwd: '/repo' })).toBe('src/file.ts');
    });
    it("resolves a running Agent's references against a worktree Workbench Root it entered without reporting it", () => {
        const agent = { cwd: '/repo', lastAgentProcessState: 'running' as const };
        expect(
            terminalReferencePath('/worktrees/task/docker-compose', agent, '/worktrees/task'),
        ).toBe('docker-compose');
        // A path under the launch cwd keeps resolving against it, and one outside both stays absolute.
        expect(terminalReferencePath('/repo/src/file.ts', agent, '/worktrees/task')).toBe(
            'src/file.ts',
        );
        expect(terminalReferencePath('/elsewhere/file.ts', agent, '/worktrees/task')).toBe(
            '/elsewhere/file.ts',
        );
        // A plain shell's relative paths resolve against where it stands, so the Workbench Root never applies.
        expect(
            terminalReferencePath(
                '/worktrees/task/docker-compose',
                { cwd: '/repo' },
                '/worktrees/task',
            ),
        ).toBe('/worktrees/task/docker-compose');
    });
    it('uses the shell launch directory after the Agent child exits', () => {
        const terminal = {
            cwd: '/repo',
            agentCwd: '/worktrees/task',
            lastAgentProcessState: 'stopped' as const,
        };
        expect(terminalReferencePath('/worktrees/task/src/file.ts', terminal)).toBe(
            '/worktrees/task/src/file.ts',
        );
        expect(terminalReferencePath('/repo/src/file.ts', terminal)).toBe('src/file.ts');
    });
});

describe('OS file references in an SSH Host window', () => {
    const finderDrop = {
        dataTransfer: {
            files: [{ name: 'crash.log' }],
            getData: () => '',
            types: ['Files'],
        },
    } as unknown as DragEvent;

    function useEnvironment(kind: 'local' | 'ssh'): void {
        vi.stubGlobal('caxri', {
            pathForFile: (file: { name: string }) => `/Users/me/Downloads/${file.name}`,
        });
        useEnvironmentStore.setState({
            state:
                kind === 'local'
                    ? { kind: 'local' }
                    : {
                          kind: 'ssh',
                          destination: 'builder',
                          hostIdentity: 'builder',
                          phase: 'connected',
                          needsUserAction: false,
                      },
        });
    }

    afterEach(() => {
        vi.unstubAllGlobals();
        useEnvironmentStore.setState({ state: undefined });
    });

    it('cites no path from this Mac and signals the refusal, so an Agent on the SSH Host never gets a path it cannot open', () => {
        useEnvironment('ssh');
        expect(isOsFileReferenceRefused()).toBe(true);
        expect(terminalDragPaths(finderDrop)).toEqual([]);
        expect(osFilePaths([{ name: 'crash.log' } as File])).toEqual([]);
        // The drag is still accepted, so the drop can explain the refusal instead of falling through.
        expect(hasTerminalDraggedPath(finderDrop)).toBe(true);
    });

    it("still inserts Caxri's own Files entries, which carry SSH Host paths", () => {
        useEnvironment('ssh');
        const data: Record<string, string> = {};
        startFilePathDrag(
            {
                setData: (type: string, value: string) => {
                    data[type] = value;
                },
            } as DataTransfer,
            '/home/me/repo/src/main.ts',
            false,
        );
        expect(terminalDragPaths(fakeDragEvent(data))).toEqual(['/home/me/repo/src/main.ts']);
    });

    it('keeps citing files from another application in a local window', () => {
        useEnvironment('local');
        expect(isOsFileReferenceRefused()).toBe(false);
        expect(terminalDragPaths(finderDrop)).toEqual(['/Users/me/Downloads/crash.log']);
    });
});
