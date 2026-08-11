import { ProcessExplorerApp } from './ProcessExplorerApp';

const forcedRenderErrorKey = 'caxri.process-explorer.forced-render-error';
const forceRenderError =
    new URLSearchParams(window.location.search).get('caxri-test-render-error') === '1' &&
    sessionStorage.getItem(forcedRenderErrorKey) !== 'consumed';
if (forceRenderError) sessionStorage.setItem(forcedRenderErrorKey, 'consumed');

/** Process Explorer entry content plus its one-shot E2E render-exception seam. */
export function ProcessExplorerRoot() {
    if (forceRenderError) throw new Error('Forced Process Explorer render error');
    return <ProcessExplorerApp />;
}
