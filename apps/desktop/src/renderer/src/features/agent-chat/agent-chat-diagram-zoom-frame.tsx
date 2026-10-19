import type { ReactNode } from 'react';
import { useId } from 'react';

import { PreviewZoomView } from '../preview/preview-zoom-view';

/**
 * The full-screen frame for a Chat diagram: the `.mmd` preview's zoomable, pannable view. Each opening gets its own
 * view-state key, so it starts at Fit instead of the zoom an earlier diagram was left at.
 */
export function AgentChatDiagramZoomFrame({ children }: { children: ReactNode }) {
    const viewStateKey = `agent-chat-diagram:${useId()}`;
    return <PreviewZoomView viewStateKey={viewStateKey}>{children}</PreviewZoomView>;
}
