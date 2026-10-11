import {
    agentStatusTabPath,
    agentTaskTabPath,
    agentTranscriptTabPath,
    agentTurnReviewTabPath,
    externalEditorTabPath,
    gitChangesDiffTabPath,
    gitFileDiffTabPath,
    settingsTabPath,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { documentTabPresentation } from '../document-tab-presentation';

describe('documentTabPresentation', () => {
    it('keeps file names accessible while exposing their full path on hover', () => {
        expect(documentTabPresentation('/project/notes.md', {})).toEqual({
            fileIconName: 'notes.md',
            icon: 'file',
            label: 'notes.md',
            labelTooltip: '/project/notes.md',
        });
        expect(
            documentTabPresentation(externalEditorTabPath('external-1', 'notes.md'), {
                displayPath: '/outside/notes.md',
            }),
        ).toEqual({
            fileIconName: 'notes.md',
            icon: 'file',
            label: 'notes.md',
            labelTooltip: '/outside/notes.md',
        });
    });
    it('does not expose opaque virtual identities as hover paths', () => {
        for (const path of [
            gitFileDiffTabPath('repo', 'src/file.ts'),
            gitChangesDiffTabPath('repo', 'project'),
            agentTranscriptTabPath('terminal-1'),
        ]) {
            const result = documentTabPresentation(path, { transcriptTitle: 'Fixture Agent' });
            expect(result.labelTooltip).toBe(result.label);
            expect(result.label).not.toContain('://');
        }
        expect(
            documentTabPresentation(gitChangesDiffTabPath('repo', 'project'), {}).fileIconName,
        ).toBe('changes.diff');
        expect(documentTabPresentation(agentTranscriptTabPath('terminal-1'), {}).fileIconName).toBe(
            'transcript.jsonl',
        );
        expect(
            documentTabPresentation(gitFileDiffTabPath('repo', 'src/file.ts'), {}).fileIconName,
        ).toBe('file.ts');
    });
    it('labels the Settings tab with its own icon, without exposing its opaque scheme', () => {
        expect(documentTabPresentation(settingsTabPath(), {})).toEqual({
            fileIconName: undefined,
            icon: 'settings',
            label: 'Settings',
            labelTooltip: 'Settings',
        });
    });
    it('labels Agent Chat task tabs by their task, with the glyph of its kind', () => {
        const path = agentTaskTabPath('terminal-1', 'task-1');
        expect(
            documentTabPresentation(path, { task: { kind: 'shell', title: 'bun run dev' } }),
        ).toEqual({
            fileIconName: undefined,
            icon: 'shell-task',
            label: 'bun run dev',
            labelTooltip: 'bun run dev',
        });
        expect(documentTabPresentation(path, {})).toMatchObject({
            icon: 'agent-task',
            label: 'Subagent',
        });
    });

    it('labels an Agent Chat turn review as the turn changes, with the changes glyph', () => {
        expect(documentTabPresentation(agentTurnReviewTabPath('terminal-1', 'turn-1'), {})).toEqual(
            {
                fileIconName: 'changes.diff',
                icon: 'file',
                label: 'Turn changes',
                labelTooltip: 'Turn changes',
            },
        );
    });

    it('names an Agent status tab after its Agent, with the gauge glyph', () => {
        const path = agentStatusTabPath('terminal-1');
        expect(documentTabPresentation(path, { agentName: 'Codex' })).toEqual({
            fileIconName: undefined,
            icon: 'agent-status',
            label: 'Codex Status',
            labelTooltip: 'Codex Status',
        });
        expect(documentTabPresentation(path, {}).label).toBe('Agent Status');
    });
});
