import {
    agentStatusTabPath,
    agentTaskTabPath,
    agentTranscriptTabPath,
    externalEditorTabPath,
    filePreviewTabPath,
    gitFileDiffTabPath,
    settingsTabPath,
    usageTabPath,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { shouldShowActiveFileStatus } from '../active-file-status-target';

describe('shouldShowActiveFileStatus', () => {
    it('shows file status for a Project file path', () => {
        expect(shouldShowActiveFileStatus('/workspace/project/src/index.ts')).toBe(true);
    });

    it('hides file status for every virtual editor tab', () => {
        const virtualPaths = [
            filePreviewTabPath('/workspace/project/README.md'),
            agentTranscriptTabPath('terminal-1'),
            agentTaskTabPath('terminal-1', 'task-1'),
            agentStatusTabPath('terminal-1'),
            externalEditorTabPath('document-1', 'notes.md'),
            settingsTabPath(),
            usageTabPath(),
            gitFileDiffTabPath('repo-1', 'src/index.ts'),
        ];
        for (const path of virtualPaths) expect(shouldShowActiveFileStatus(path), path).toBe(false);
    });
});
