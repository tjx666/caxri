import type { SessionState } from '@caxri/protocol';
import { externalEditorTabPath, filePreviewTabPath, listPaneTabs } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
    mergeExternalEditorTabs,
    recordExternalEditorState,
    resetExternalEditorStateForTests,
    stripExternalEditorTabs,
} from '../external-editor-state';

function sessionState(...paths: string[]): SessionState {
    return {
        sessionId: 'session-1',
        revision: 0,
        workbenchRootProjectId: 'project-1',
        desiredSecondarySidebarViewContainerId: 'caxri.files',
        paneLayout: {
            root: {
                type: 'pane',
                id: 'pane-1',
                tabs: paths.map((path, index) => ({
                    id: `tab-${index}`,
                    resource: { kind: 'file', path },
                })),
                activeTabId: `tab-${paths.length - 1}`,
            },
            activePaneId: 'pane-1',
        },
    };
}

function tabPaths(state: SessionState): string[] {
    return listPaneTabs(state.paneLayout).flatMap(({ tab }) =>
        tab.resource.kind === 'file' ? [tab.resource.path] : [],
    );
}

afterEach(() => {
    resetExternalEditorStateForTests();
});

describe('external editor state', () => {
    it('keeps a preview of an external document out of persisted Session state', () => {
        const external = externalEditorTabPath('external-1', 'guide.md');
        const preview = filePreviewTabPath(external);
        const visible = sessionState('/project/kept.ts', external, preview);

        const stripped = stripExternalEditorTabs(visible);
        expect(tabPaths(stripped)).toEqual(['/project/kept.ts']);

        recordExternalEditorState(visible);
        const restored = mergeExternalEditorTabs(stripped);
        expect(tabPaths(restored)).toEqual(['/project/kept.ts', external, preview]);
    });

    it('persists a preview of a Project file', () => {
        const preview = filePreviewTabPath('/project/README.md');
        const stripped = stripExternalEditorTabs(sessionState(preview));
        expect(tabPaths(stripped)).toEqual([preview]);
    });
});
