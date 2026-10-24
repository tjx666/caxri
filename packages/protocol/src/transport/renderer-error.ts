export const RENDERER_ERROR_CHANNELS = {
    performanceMonitor: 'caxri:performance-monitor:renderer-error',
    processExplorer: 'caxri:process-explorer:renderer-error',
    workbench: 'caxri:renderer-error',
} as const;

const RENDERER_ERROR_KINDS = ['page-exception', 'unhandled-rejection'] as const;
export type RendererErrorKind = (typeof RENDERER_ERROR_KINDS)[number];

export function isRendererErrorKind(value: unknown): value is RendererErrorKind {
    // `Array#includes` narrows its argument to the tuple's element type, but this is a runtime type
    // guard over an `unknown` input; widen the array's type for the call instead of narrowing `value`.
    return (RENDERER_ERROR_KINDS as readonly unknown[]).includes(value);
}
