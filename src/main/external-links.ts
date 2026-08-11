import type { MethodResult } from '../shared/ipc/methods';

export interface ExternalUrlDependencies {
    confirm(url: URL): Promise<boolean>;
    open(url: string): Promise<void>;
}

/** Validates and opens a Renderer-submitted URL without giving the Renderer native authority. */
export async function openExternalUrl(
    input: string,
    dependencies: ExternalUrlDependencies,
): Promise<MethodResult<'external.open'>> {
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        return { status: 'rejected', reason: 'invalid_url' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        return { status: 'rejected', reason: 'unsupported_protocol' };
    if (!(await dependencies.confirm(url))) return { status: 'canceled' };
    await dependencies.open(url.toString());
    return { status: 'opened' };
}
