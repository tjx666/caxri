import {
    agentTranscriptTabLabel,
    gitDiffTabLabel,
    parseAgentTranscriptTab,
    parseExternalEditorTab,
    parseGitDiffTab,
} from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';

/**
 * Keeps resource labels and filesystem hover paths consistent without branching inside tab rendering.
 */
export function documentTabPresentation(
    path: string,
    options: { displayPath?: string; transcriptTitle?: string },
) {
    const diff = parseGitDiffTab(path);
    const transcript = parseAgentTranscriptTab(path);
    const external = parseExternalEditorTab(path);
    const label = diff
        ? gitDiffTabLabel(diff)
        : transcript
          ? agentTranscriptTabLabel(options.transcriptTitle)
          : (external?.name ?? pathBasename(path));
    return {
        fileIconName:
            diff?.kind === 'file'
                ? pathBasename(diff.path)
                : diff?.kind === 'changes'
                  ? 'changes.diff'
                  : transcript
                    ? 'transcript.jsonl'
                    : (external?.name ?? pathBasename(path)),
        label,
        labelTooltip: diff || transcript ? label : (options.displayPath ?? external?.name ?? path),
    };
}
