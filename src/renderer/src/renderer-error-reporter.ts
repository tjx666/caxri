import type { RendererErrorKind } from '@shared/renderer-error';

/**
 * Reports only the exception class across the preload boundary. Error values and rejection reasons
 * stay in the Renderer because they may include source, prompts, responses, or workspace data.
 */
export function installRendererErrorReporter(report: (kind: RendererErrorKind) => void): void {
    window.addEventListener('error', () => report('page-exception'));
    window.addEventListener('unhandledrejection', () => report('unhandled-rejection'));
}
