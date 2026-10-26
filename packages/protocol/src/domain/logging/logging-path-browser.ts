/**
 * Main's Project-wide name search behind the path browser.
 */
export const pathBrowserLogEvents = {
    /**
     * One record per `pathBrowser.browse` call that ran the Project-wide name search (memo hit or a fresh
     * `files.search`), success or not. `file.search` already covers Server Core's own view of the scan; this event
     * covers what Main did with the result: the memo/root-containment/budget steps a slow or missing search engine
     * would otherwise hide behind an unremarkable empty result. See issue caxri#924.
     */
    searchFallback: 'path_browser.search_fallback',
    /**
     * The Project-wide name search could not run at all. Carries `PathBrowserSearchFailureReason` instead of the thrown
     * error's message so a packaged install missing ripgrep reads as a diagnosable reason, not as silence.
     */
    searchFailed: 'path_browser.search_failed',
} as const;
