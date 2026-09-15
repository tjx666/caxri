import {
    agentTranscriptTabLabel,
    filePreviewTabLabel,
    gitDiffTabLabel,
    parseAgentTranscriptTab,
    parseExternalEditorTab,
    parseFilePreviewTab,
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
    const preview = parseFilePreviewTab(path);
    const label = diff
        ? gitDiffTabLabel(diff)
        : transcript
          ? agentTranscriptTabLabel(options.transcriptTitle)
          : preview
            ? filePreviewTabLabel(preview.path)
            : (external?.name ?? pathBasename(path));
    return {
        fileIconName:
            diff?.kind === 'file'
                ? pathBasename(diff.path)
                : diff?.kind === 'changes'
                  ? 'changes.diff'
                  : transcript
                    ? 'transcript.jsonl'
                    : preview
                      ? pathBasename(preview.path)
                      : (external?.name ?? pathBasename(path)),
        label,
        // A preview tab shows its source path: the label already says "Preview", so the tooltip's job is locating it.
        labelTooltip: preview
            ? preview.path
            : diff || transcript
              ? label
              : (options.displayPath ?? external?.name ?? path),
    };
}
