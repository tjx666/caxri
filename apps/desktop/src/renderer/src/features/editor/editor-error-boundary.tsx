import type { ReactNode } from 'react';

import { SurfaceErrorBoundary } from '../../components/surface-error-boundary';
import { useTranslation } from '../../i18n';
import { EditorLoadFailure } from './editor-load-failure';
import { editorRenderFailureReason } from './editor-load-state';

/**
 * The boundary's fallback, split out because the boundary class cannot read the translation hook.
 */
function EditorRenderFailure({ error }: { error: unknown }) {
    const { t } = useTranslation();
    return (
        <EditorLoadFailure
            actionLabel={t('editor.load.reloadWindow')}
            reason={t(editorRenderFailureReason(error))}
            onAction={() => {
                location.reload();
            }}
        />
    );
}

/**
 * Pane-local render guard for the editor area, on the shared `SurfaceErrorBoundary`. The diff, transcript, preview, and
 * Settings surfaces are `React.lazy` chunks behind a bare `Suspense`, which covers only the pending state: a rejected
 * import (a stale or missing build asset) or an exception thrown while one rendered reached the window-level
 * `ErrorBoundary` and replaced the whole window with the crash screen (issue #1012). Caught here, the failure stays
 * inside the pane that showed the tab, in the same shape as the file editor's own load failure.
 *
 * Reloading the window is the only recovery offered. `React.lazy` keeps a rejected import for the lifetime of the page,
 * so rendering the same tab again would rethrow the same failure; the reload requests the asset again, and nothing is
 * lost because durable workbench state lives in the Server.
 *
 * `resetKey` is the tab the pane is showing. Another tab clears the failure: it has content of its own, and the failed
 * tab stays failed only for as long as it is the one on screen.
 */
export function EditorErrorBoundary({
    children,
    resetKey,
}: {
    children: ReactNode;
    resetKey: string;
}) {
    return (
        <SurfaceErrorBoundary
            fallback={({ error }) => <EditorRenderFailure error={error} />}
            resetKey={resetKey}
            scope="editor"
        >
            {children}
        </SurfaceErrorBoundary>
    );
}
