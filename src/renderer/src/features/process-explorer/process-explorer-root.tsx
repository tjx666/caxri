import { ProcessExplorerApp } from './process-explorer-app';

const forcedRenderErrorKey = 'caxri.process-explorer.forced-render-error';
const isForceRenderError =
    new URLSearchParams(location.search).get('caxri-test-render-error') === '1' &&
    sessionStorage.getItem(forcedRenderErrorKey) !== 'consumed';
if (isForceRenderError) sessionStorage.setItem(forcedRenderErrorKey, 'consumed');

/**
Process Explorer entry content plus its one-shot E2E render-exception seam.
 */
export function ProcessExplorerRoot() {
    if (isForceRenderError) throw new Error('Forced Process Explorer render error');
    return <ProcessExplorerApp />;
}
