import {
    agentContextTabPath,
    agentStatusTabPath,
    agentTaskTabPath,
    agentTranscriptTabPath,
    agentTurnReviewTabPath,
    externalEditorTabPath,
    filePreviewTabPath,
    gitChangesDiffTabPath,
    gitFileDiffTabPath,
    settingsTabPath,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import { documentTabPresentation, externalTabParentLabel } from '../document-tab-presentation';

describe('documentTabPresentation', () => {
    it('keeps file names accessible while exposing their full path on hover', () => {
        expect(documentTabPresentation('/project/notes.md', {}, translate)).toEqual({
            fileIconName: 'notes.md',
            icon: 'file',
            label: 'notes.md',
            labelTooltip: '/project/notes.md',
        });
        expect(
            documentTabPresentation(
                externalEditorTabPath('external-1', 'notes.md'),
                {
                    displayPath: '/outside/notes.md',
                },
                translate,
            ),
        ).toEqual({
            accessibleDetail: 'Outside every Project',
            fileIconName: 'notes.md',
            icon: 'file',
            label: 'notes.md',
            labelTooltip: '/outside/notes.md',
        });
    });
    it('shows the display path of an external preview, never its opaque identity', () => {
        const source = externalEditorTabPath('external-1', 'notes.md');
        const preview = documentTabPresentation(
            filePreviewTabPath(source),
            {
                previewSourceDisplayPath: '/outside/notes.md',
            },
            translate,
        );
        expect(preview).toMatchObject({
            accessibleDetail: 'Outside every Project',
            label: 'Preview: notes.md',
            labelTooltip: '/outside/notes.md',
        });
        // Once the source document is gone, the tooltip falls back to the filename rather than the scheme.
        expect(
            documentTabPresentation(filePreviewTabPath(source), {}, translate).labelTooltip,
        ).toBe('notes.md');
        expect(
            documentTabPresentation(filePreviewTabPath('/project/a.md'), {}, translate),
        ).toMatchObject({
            labelTooltip: '/project/a.md',
        });
    });
    it('drops the Preview prefix for a format whose preview is its only view', () => {
        expect(
            documentTabPresentation(filePreviewTabPath('/project/manual.pdf'), {}, translate).label,
        ).toBe('manual.pdf');
        expect(
            documentTabPresentation(filePreviewTabPath('/project/a.md'), {}, translate).label,
        ).toBe('Preview: a.md');
    });
    it('gives a repeated external filename its parent directory as a detail', () => {
        const path = externalEditorTabPath('external-1', 'README.md');
        expect(
            documentTabPresentation(
                path,
                {
                    displayPath: '/work/api/README.md',
                    externalDisplayPaths: ['/work/api/README.md', '/work/web/README.md'],
                },
                translate,
            ).detail,
        ).toBe('api');
        expect(
            documentTabPresentation(
                path,
                {
                    displayPath: '/work/api/README.md',
                    externalDisplayPaths: ['/work/api/README.md', '/work/api/notes.md'],
                },
                translate,
            ).detail,
        ).toBeUndefined();
    });
    it('does not expose opaque virtual identities as hover paths', () => {
        for (const path of [
            gitFileDiffTabPath('repo', 'src/file.ts'),
            gitChangesDiffTabPath('repo', 'project'),
            agentTranscriptTabPath('terminal-1'),
        ]) {
            const result = documentTabPresentation(
                path,
                { transcriptTitle: 'Fixture Agent' },
                translate,
            );
            expect(result.labelTooltip).toBe(result.label);
            expect(result.label).not.toContain('://');
        }
        expect(
            documentTabPresentation(gitChangesDiffTabPath('repo', 'project'), {}, translate)
                .fileIconName,
        ).toBe('changes.diff');
        expect(
            documentTabPresentation(agentTranscriptTabPath('terminal-1'), {}, translate)
                .fileIconName,
        ).toBe('transcript.jsonl');
        expect(
            documentTabPresentation(gitFileDiffTabPath('repo', 'src/file.ts'), {}, translate)
                .fileIconName,
        ).toBe('file.ts');
    });
    it('labels the Settings tab with its own icon, without exposing its opaque scheme', () => {
        expect(documentTabPresentation(settingsTabPath(), {}, translate)).toEqual({
            fileIconName: undefined,
            icon: 'settings',
            label: 'Settings',
            labelTooltip: 'Settings',
        });
    });
    it('labels Agent Chat task tabs by their task, with the glyph of its kind', () => {
        const path = agentTaskTabPath('terminal-1', 'task-1');
        expect(
            documentTabPresentation(
                path,
                { task: { kind: 'shell', title: 'bun run dev' } },
                translate,
            ),
        ).toEqual({
            fileIconName: undefined,
            icon: 'shell-task',
            label: 'bun run dev',
            labelTooltip: 'bun run dev',
        });
        expect(documentTabPresentation(path, {}, translate)).toMatchObject({
            icon: 'agent-task',
            label: 'Subagent',
        });
    });

    it('labels an Agent Chat turn review as the turn changes, with the changes glyph', () => {
        expect(
            documentTabPresentation(agentTurnReviewTabPath('terminal-1', 'turn-1'), {}, translate),
        ).toEqual({
            fileIconName: 'changes.diff',
            icon: 'file',
            label: 'Turn changes',
            labelTooltip: 'Turn changes',
        });
    });

    it('names an Agent status tab after its Agent, with the gauge glyph', () => {
        const path = agentStatusTabPath('terminal-1');
        expect(documentTabPresentation(path, { agentName: 'Codex' }, translate)).toEqual({
            fileIconName: undefined,
            icon: 'agent-status',
            label: 'Codex Status',
            labelTooltip: 'Codex Status',
        });
        expect(documentTabPresentation(path, {}, translate).label).toBe('Agent Status');
    });

    it('labels a context tab and names its Terminal in the tooltip', () => {
        expect(
            documentTabPresentation(
                agentContextTabPath('terminal-1'),
                {
                    agentTerminalTitle: 'api-fix',
                },
                translate,
            ),
        ).toEqual({
            fileIconName: undefined,
            icon: 'agent-context',
            label: 'Context',
            labelTooltip: 'Context · api-fix',
        });
    });

    it('tells two status tabs for the same Agent apart by their Terminal', () => {
        expect(
            documentTabPresentation(
                agentStatusTabPath('terminal-1'),
                {
                    agentName: 'Codex',
                    agentTerminalTitle: 'api-fix',
                },
                translate,
            ).labelTooltip,
        ).toBe('Codex Status · api-fix');
    });
});

describe('externalTabParentLabel', () => {
    it('widens to the shortest directory suffix that is unique', () => {
        expect(
            externalTabParentLabel('/a/packages/api/README.md', [
                '/a/packages/api/README.md',
                '/b/apps/api/README.md',
            ]),
        ).toBe('packages/api');
    });

    it('ignores duplicate entries for the same file', () => {
        expect(
            externalTabParentLabel('/a/README.md', ['/a/README.md', '/a/README.md']),
        ).toBeUndefined();
    });
});
