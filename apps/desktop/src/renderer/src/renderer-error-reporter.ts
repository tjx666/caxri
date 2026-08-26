import type { RendererErrorKind } from '@caxri/protocol';

/**
 * Reports only the exception class across the preload boundary. Error values and rejection reasons stay in the Renderer
 * because they may include source, prompts, responses, or workspace data.
 */
export function installRendererErrorReporter(report: (kind: RendererErrorKind) => void): void {
    addEventListener('error', () => report('page-exception'));
    addEventListener('unhandledrejection', () => report('unhandled-rejection'));
}
