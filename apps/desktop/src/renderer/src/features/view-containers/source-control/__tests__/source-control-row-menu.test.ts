import { afterEach, describe, expect, it, vi } from 'vitest';

const caxriRequest = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/caxri', () => ({ caxri: { request: caxriRequest } }));

import type { ContextMenuEntries } from '../../../../lib/context-menu';
import { serializeContextMenu } from '../../../../lib/context-menu';
import { useEnvironmentStore } from '../../../../stores/environment';
import { useWorkbenchStore } from '../../../../stores/workbench';
import { sourceControlResourcePathMenu } from '../source-control-row-menu';

const clipboard = vi.hoisted(() => ({
    writeText: vi.fn<(text: string) => Promise<void>>(),
}));
vi.mock('../../../../lib/clipboard', () => ({
    textClipboard: { writeText: (text: string) => clipboard.writeText(text) },
    writeClipboardText: (text: string) => clipboard.writeText(text),
}));

function selectProject(rootPath: string | undefined): void {
    useWorkbenchStore.setState({
        bootstrap: rootPath
            ? ({
                  selectedSessionId: 'session-1',
                  sessions: [{ id: 'session-1', workbenchRootProjectId: 'project-1' }],
                  projects: [{ id: 'project-1', rootPath }],
              } as never)
            : undefined,
    });
}

function selectableItems(entries: ContextMenuEntries) {
    const { actions, items } = serializeContextMenu(entries);
    return items.flatMap((item) =>
        item.type === 'separator' ? [] : [{ label: item.label, run: actions.get(item.id!)! }],
    );
}

describe('sourceControlResourcePathMenu', () => {
    afterEach(() => {
        selectProject(undefined);
        useEnvironmentStore.setState({ state: undefined });
        caxriRequest.mockReset();
        vi.unstubAllGlobals();
    });

    it('copies the absolute path, the Project-relative path, and the file name', async () => {
        const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
        clipboard.writeText = writeText;
        selectProject('/project');

        const items = selectableItems(
            sourceControlResourcePathMenu(
                '/project/packages/sub/src/a.ts',
                '/project/packages/sub',
                true,
            ),
        );
        expect(items.map((item) => item.label)).toEqual([
            'Copy Path',
            'Copy Relative Path',
            'Copy Name',
        ]);
        await Promise.all(items.map((item) => item.run()));
        expect(writeText.mock.calls.map(([value]) => value)).toEqual([
            '/project/packages/sub/src/a.ts',
            'packages/sub/src/a.ts',
            'a.ts',
        ]);
    });

    it('measures a linked repository outside the Project from its own root', async () => {
        const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
        clipboard.writeText = writeText;
        selectProject('/project');

        const relative = selectableItems(
            sourceControlResourcePathMenu('/elsewhere/linked/src/a.ts', '/elsewhere/linked', true),
        ).find((item) => item.label === 'Copy Relative Path');
        await relative?.run();
        expect(writeText).toHaveBeenLastCalledWith('src/a.ts');
    });

    it('reveals a changed file in Finder through the selected Session', async () => {
        selectProject('/project');
        useEnvironmentStore.setState({ state: { kind: 'local' } as never });
        caxriRequest.mockResolvedValue(undefined);

        const items = selectableItems(
            sourceControlResourcePathMenu('/project/src/a.ts', '/project', true),
        );
        expect(items.map((item) => item.label)).toEqual([
            'Reveal in Finder',
            'Copy Path',
            'Copy Relative Path',
            'Copy Name',
        ]);
        await items[0].run();
        expect(caxriRequest).toHaveBeenCalledWith('files.reveal', {
            sessionId: 'session-1',
            path: '/project/src/a.ts',
        });
    });

    it('omits Reveal in Finder for a deleted change and in an SSH Host window', () => {
        selectProject('/project');
        useEnvironmentStore.setState({ state: { kind: 'local' } as never });
        const labels = (isOnDisk: boolean) =>
            selectableItems(
                sourceControlResourcePathMenu('/project/src/a.ts', '/project', isOnDisk),
            ).map((item) => item.label);

        expect(labels(false)).not.toContain('Reveal in Finder');
        useEnvironmentStore.setState({ state: { kind: 'ssh' } as never });
        expect(labels(true)).not.toContain('Reveal in Finder');
    });
});
