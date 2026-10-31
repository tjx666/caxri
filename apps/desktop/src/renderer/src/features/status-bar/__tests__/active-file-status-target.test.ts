import {
    agentStatusTabPath,
    agentTaskTabPath,
    agentTranscriptTabPath,
    environmentTabPath,
    externalEditorTabPath,
    filePreviewTabPath,
    gitFileDiffTabPath,
    usageTabPath,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { activeFileStatusTier } from '../active-file-status-target';

describe('activeFileStatusTier', () => {
    it('shows full file status, blame included, for a Project file path', () => {
        expect(activeFileStatusTier('/workspace/project/src/index.ts')).toBe('full');
    });

    it('shows cursor and language but no blame for an external document tab', () => {
        expect(activeFileStatusTier(externalEditorTabPath('document-1', 'notes.md'))).toBe(
            'cursorOnly',
        );
    });

    it('hides file status for every other virtual editor tab', () => {
        const virtualPaths = [
            filePreviewTabPath('/workspace/project/README.md'),
            agentTranscriptTabPath('terminal-1'),
            agentTaskTabPath('terminal-1', 'task-1'),
            agentStatusTabPath('terminal-1'),
            environmentTabPath(),
            usageTabPath(),
            gitFileDiffTabPath('repo-1', 'src/index.ts'),
        ];
        for (const path of virtualPaths) expect(activeFileStatusTier(path), path).toBe('hidden');
    });
});
