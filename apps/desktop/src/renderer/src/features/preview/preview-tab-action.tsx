import { Eye, FileCode, Globe } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import type { HtmlPageTarget } from './html/commands';
import { openHtmlPageInBrowser } from './html/commands';
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
    const { t } = useTranslation();
    const isSource = tabSwitch.kind === 'openSource';
    const label = t(isSource ? 'preview.openSource' : 'preview.openPreviewToSide');
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

/**
 * Opens an HTML page in the system browser from its source or preview tab, for what the frame cannot do (DevTools, a
 * shareable window, the user's extensions). The tab menu's Open with Default App reaches the same launch; this puts it
 * one click away on the tabs where it is the common next step.
 */
export function HtmlBrowserTabAction({ target }: { target: HtmlPageTarget }) {
    const { t } = useTranslation();
    const label = t('preview.openInBrowser');
    return (
        <Tooltip content={label}>
            <Button
                size="icon"
                variant="ghost"
                aria-label={label}
                onClick={() => {
                    void openHtmlPageInBrowser(target);
                }}
            >
                <Globe aria-hidden="true" size={14} />
            </Button>
        </Tooltip>
    );
}
