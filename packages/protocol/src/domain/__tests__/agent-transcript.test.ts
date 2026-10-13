import { describe, expect, it } from 'vitest';

import {
    agentTranscriptTabPath,
    isAgentTranscriptTabPath,
    parseAgentTranscriptTab,
} from '../agent-transcript';
import { gitFileDiffTabPath } from '../git-diff';
import { isVirtualEditorTabPath } from '../virtual-tabs';

describe('Agent transcript tabs', () => {
    it('round-trips terminal identity through the encoded path', () => {
        const path = agentTranscriptTabPath('terminal/1');

        expect(parseAgentTranscriptTab(path)).toEqual({ terminalId: 'terminal/1' });
        expect(isAgentTranscriptTabPath(path)).toBe(true);
    });

    it('resolves legacy title-bearing paths to the same terminal identity', () => {
        expect(
            parseAgentTranscriptTab('caxri-agent-transcript://terminal-1/Claude%20Code'),
        ).toEqual({ terminalId: 'terminal-1' });
    });

    it('rejects ordinary file paths and git diff tab paths', () => {
        expect(parseAgentTranscriptTab('/project/src/a.ts')).toBeUndefined();
        expect(parseAgentTranscriptTab(gitFileDiffTabPath('repo', 'src/a.ts'))).toBeUndefined();
        expect(isAgentTranscriptTabPath('caxri-agent-transcript://')).toBe(false);
    });

    it('is treated as a virtual editor tab alongside git diff tabs', () => {
        expect(isVirtualEditorTabPath(agentTranscriptTabPath('t1'))).toBe(true);
        expect(isVirtualEditorTabPath(gitFileDiffTabPath('repo', 'src/a.ts'))).toBe(true);
        expect(isVirtualEditorTabPath('/project/src/a.ts')).toBe(false);
    });
});
