import { isCaxriError } from '@caxri/protocol';

/**
 * Closed reasons Main attaches as `details.reason` to a `PATH_DENIED` refusal from the Open File by Path browser, so
 * the Renderer explains it in the user's language instead of showing Main's English message.
 *
 * - `homeUnavailable`: `~` names nothing this window may browse (an SSH Host window covers its Project only).
 * - `outsideProjectRoot`: the typed path leaves the Project the browser is scoped to.
 */
const pathBrowserDenialReasons = ['homeUnavailable', 'outsideProjectRoot'] as const;

export type PathBrowserDenialReason = (typeof pathBrowserDenialReasons)[number];

export function pathBrowserDenialDetails(reason: PathBrowserDenialReason): { reason: string } {
    return { reason };
}

/**
 * The closed reason of a path browser refusal, or `undefined` for any other failure.
 */
export function pathBrowserDenialReason(error: unknown): PathBrowserDenialReason | undefined {
    if (!isCaxriError(error) || error.code !== 'PATH_DENIED') return undefined;
    const reason = error.details?.reason;
    return pathBrowserDenialReasons.find((candidate) => candidate === reason);
}
