import { Eye } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { openFilePreviewToSide } from './preview-commands';

/**
 * The tab rail's preview icon opens the preview beside the source rather than in place, following VS Code's
 * `editor/title` contribution for Markdown: from the rail the user is looking at the source, and the point of a
 * one-click affordance there is to keep seeing it. In-place opening stays with `Cmd+Shift+V` and the context menus.
 */
export function PreviewTabAction({ path }: { path: string }) {
    return (
        <Tooltip content="Open Preview to the Side">
            <Button
                size="icon"
                variant="ghost"
                aria-label="Open Preview to the Side"
                onClick={() => openFilePreviewToSide(path)}
            >
                <Eye aria-hidden="true" size={14} />
            </Button>
        </Tooltip>
    );
}
