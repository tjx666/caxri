import type { VirtualEditorTabScheme } from '@caxri/protocol';
import {
    agentContextTabPath,
    agentSideChatTabPath,
    agentStatusTabPath,
    agentTaskTabPath,
    agentTranscriptTabPath,
    agentTurnReviewTabPath,
    externalEditorTabPath,
    filePreviewTabPath,
    gitFileDiffTabPath,
    settingsTabPath,
    usageTabPath,
    virtualEditorTabScheme,
    virtualEditorTabSchemes,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { virtualTabDescriptors } from '../virtual-tab-descriptors';

/**
 * One representative path per scheme. Typed as a full `Record` so adding a scheme without a sample fails typecheck.
 */
const samplePaths: Record<VirtualEditorTabScheme, string> = {
    gitDiff: gitFileDiffTabPath('repo-1', 'src/a.ts'),
    agentTranscript: agentTranscriptTabPath('terminal-1'),
    agentTask: agentTaskTabPath('terminal-1', 'task-1'),
    agentTurnReview: agentTurnReviewTabPath('terminal-1', 'turn-1'),
    agentStatus: agentStatusTabPath('terminal-1'),
    agentContext: agentContextTabPath('terminal-1'),
    agentSideChat: agentSideChatTabPath('terminal-1'),
    external: externalEditorTabPath('document-1', 'notes.md'),
    filePreview: filePreviewTabPath('/project/a.md'),
    settings: settingsTabPath(),
    usage: usageTabPath(),
};

describe('virtual tab descriptors', () => {
    it('declares a complete descriptor for every virtual tab scheme', () => {
        expect(Object.keys(virtualTabDescriptors).toSorted((a, b) => a.localeCompare(b))).toEqual(
            [...virtualEditorTabSchemes].toSorted((a, b) => a.localeCompare(b)),
        );
        for (const scheme of virtualEditorTabSchemes) {
            const descriptor = virtualTabDescriptors[scheme];
            expect(typeof descriptor.present).toBe('function');
            expect(['cursorOnly', 'hidden']).toContain(descriptor.statusBar);
            expect(descriptor).toHaveProperty('loading');
            expect(virtualEditorTabScheme(samplePaths[scheme])).toBe(scheme);
            const presentation = descriptor.present(samplePaths[scheme], {}, (key) => key);
            expect(presentation.label).not.toBe('');
            expect(presentation.labelTooltip).not.toBe('');
            expect(presentation.icon === 'file' ? presentation.fileIconName : 'glyph').toBeTruthy();
        }
    });

    it('treats a Project file path as no virtual scheme', () => {
        expect(virtualEditorTabScheme('/project/notes.md')).toBeUndefined();
    });

    it('keeps an external document the only scheme that shows cursor status', () => {
        expect(
            virtualEditorTabSchemes.filter(
                (scheme) => virtualTabDescriptors[scheme].statusBar === 'cursorOnly',
            ),
        ).toEqual(['external']);
    });
});
