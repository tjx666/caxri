/**
 * The window key a request names when Desktop Main did not attach one. Main supplies the real key for every Workbench
 * request, so this fallback only serves callers that predate it (internal Server work, tests); Server code resolves a
 * missing key here and nowhere else.
 */
const DEFAULT_WINDOW_KEY = 'main';

export function resolveWindowKey(windowKey: string | undefined): string {
    return windowKey ?? DEFAULT_WINDOW_KEY;
}
