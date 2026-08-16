import type { SessionState } from '@shared/types';
import { describe, expect, it } from 'vitest';

import { pruneEditorTabMotionStates, reconcileEditorTabMotion } from './editor-tab-motion';

type EditorTab = SessionState['openTabs'][number];

const pinned = (path: string): EditorTab => ({ dirty: false, path });
const preview = (path: string): EditorTab => ({ dirty: false, path, preview: true });

describe('Editor tab motion identity', () => {
    it('reuses one clean preview identity across consecutive replacements', () => {
        const initial = reconcileEditorTabMotion(undefined, [
            pinned('/project/pinned.ts'),
            preview('/project/a.ts'),
        ]);
        const replaced = reconcileEditorTabMotion(initial, [
            pinned('/project/pinned.ts'),
            preview('/project/b.ts'),
        ]);
        const replacedAgain = reconcileEditorTabMotion(replaced, [
            pinned('/project/pinned.ts'),
            preview('/project/c.ts'),
        ]);

        expect(replaced.tabs[1]?.motionId).toBe(initial.tabs[1]?.motionId);
        expect(replacedAgain.tabs[1]?.motionId).toBe(initial.tabs[1]?.motionId);
        expect(replaced.tabs[0]?.motionId).toBe(initial.tabs[0]?.motionId);
    });

    it('keeps the identity when pinning and allocates one for the next real tab', () => {
        const initial = reconcileEditorTabMotion(undefined, [preview('/project/a.ts')]);
        const pinnedState = reconcileEditorTabMotion(initial, [pinned('/project/a.ts')]);
        const withNextPreview = reconcileEditorTabMotion(pinnedState, [
            pinned('/project/a.ts'),
            preview('/project/b.ts'),
        ]);

        expect(pinnedState.tabs[0]?.motionId).toBe(initial.tabs[0]?.motionId);
        expect(withNextPreview.tabs[0]?.motionId).toBe(initial.tabs[0]?.motionId);
        expect(withNextPreview.tabs[1]?.motionId).not.toBe(initial.tabs[0]?.motionId);
    });

    it('allocates a new identity after a tab was actually closed', () => {
        const initial = reconcileEditorTabMotion(undefined, [preview('/project/a.ts')]);
        const closed = reconcileEditorTabMotion(initial, []);
        const reopened = reconcileEditorTabMotion(closed, [preview('/project/a.ts')]);

        expect(reopened.tabs[0]?.motionId).not.toBe(initial.tabs[0]?.motionId);
    });

    it('releases identity state for deleted Sessions', () => {
        const state = reconcileEditorTabMotion(undefined, [preview('/project/a.ts')]);
        const states = new Map([
            ['live', state],
            ['deleted', state],
        ]);

        pruneEditorTabMotionStates(states, ['live']);

        expect(states.keys().toArray()).toEqual(['live']);
    });
});
