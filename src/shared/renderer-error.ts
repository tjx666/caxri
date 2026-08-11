export const RENDERER_ERROR_CHANNELS = {
    processExplorer: 'caxri:process-explorer:renderer-error',
    workbench: 'caxri:renderer-error',
} as const;

export const RENDERER_ERROR_KINDS = ['page-exception', 'unhandled-rejection'] as const;
export type RendererErrorKind = (typeof RENDERER_ERROR_KINDS)[number];

export function isRendererErrorKind(value: unknown): value is RendererErrorKind {
    return RENDERER_ERROR_KINDS.some((kind) => kind === value);
}
