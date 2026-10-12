import { Eye, FileCode } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import type { PreviewTabSwitch } from './preview-commands';
import { openFilePreviewToSide, openPreviewSource } from './preview-commands';

/**
 * The tab rail's switch between a document's two views.
 *
 * From a source tab it opens the preview beside the source rather than in place, following VS Code's `editor/title`
 * contribution for Markdown: from the rail the user is looking at the source, and the point of a one-click affordance
 * there is to keep seeing it. In-place opening stays with `Cmd+Shift+V` and the context menus. From a preview tab it
 * opens the source, VS Code's `markdown.showSource`; offering to open the preview the user is already reading would be
 * a button that does nothing.
 */
export function PreviewTabAction({ tabSwitch }: { tabSwitch: PreviewTabSwitch }) {
    const isSource = tabSwitch.kind === 'openSource';
    const label = isSource ? 'Open Source' : 'Open Preview to the Side';
    return (
        <Tooltip content={label}>
            <Button
                size="icon"
                variant="ghost"
                aria-label={label}
                onClick={() =>
                    isSource
                        ? openPreviewSource(tabSwitch.path)
                        : openFilePreviewToSide(tabSwitch.path)
                }
            >
                {isSource ? (
                    <FileCode aria-hidden="true" size={14} />
                ) : (
                    <Eye aria-hidden="true" size={14} />
                )}
            </Button>
        </Tooltip>
    );
}
