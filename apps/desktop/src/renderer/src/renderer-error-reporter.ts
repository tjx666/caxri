import type { RendererErrorKind } from '@caxri/protocol';

import { isBenignRendererErrorMessage } from '../../shared/renderer-error-policy';

function errorMessage(event: unknown): unknown {
    return typeof event === 'object' && event !== null && 'message' in event
        ? event.message
        : undefined;
}

/**
 * Reports only the exception class across the preload boundary. Error values and rejection reasons stay in the Renderer
 * because they may include source, prompts, responses, or workspace data.
 */
export function installRendererErrorReporter(report: (kind: RendererErrorKind) => void): void {
    addEventListener('error', (event) => {
        if (!isBenignRendererErrorMessage(errorMessage(event))) report('page-exception');
    });
    addEventListener('unhandledrejection', () => report('unhandled-rejection'));
}
