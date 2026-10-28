/**
 * Where a link should open: `inApp` for an ordinary web page, which the in-app browser shows, and `external` for
 * everything else (`mailto:`, `tel:`, an app's own scheme, Android `intent:`), which only the system can resolve.
 */
export type LinkTarget = 'external' | 'inApp';

const parseUrl = (url: string): URL | null => {
    try {
        return new URL(url);
    } catch {
        return null;
    }
};

export function linkTarget(url: string): LinkTarget {
    const protocol = parseUrl(url)?.protocol;
    return protocol === 'http:' || protocol === 'https:' ? 'inApp' : 'external';
}

/**
 * What a navigation inside the in-app browser does: web pages and `about:` documents load in place, while any other
 * scheme leaves for the app that owns it, the way a system browser hands `mailto:` to the mail app.
 */
export function browserNavigation(url: string): 'external' | 'load' {
    if (url.startsWith('about:')) return 'load';
    return linkTarget(url) === 'inApp' ? 'load' : 'external';
}

/**
 * The host a page lives on, without a leading `www.`, as the toolbar names it while the title is unknown; the raw text
 * when it is not a URL.
 */
export function browserDisplayHost(url: string): string {
    const host = parseUrl(url)?.host;
    if (!host) return url;
    return host.startsWith('www.') ? host.slice(4) : host;
}

/**
 * The text of the toolbar pill. A page without a title (or one still loading, when the title is the URL) is named by
 * its host, as X's pill does. While the load has failed the WebView still reports Chromium's own error page title (for
 * example `Webpage not available`), which the app's error view has replaced, so the pill keeps the host.
 */
export function browserPillTitle(page: {
    hasLoadFailed: boolean;
    title: string;
    url: string;
}): string {
    const host = browserDisplayHost(page.url);
    if (page.hasLoadFailed) return host;
    return page.title && page.title !== page.url ? page.title : host;
}

export function isSecurePage(url: string): boolean {
    return parseUrl(url)?.protocol === 'https:';
}

/**
 * The caller-supplied name for the page the browser was opened on (for example `Preview · :5173`), which stands in for
 * the gateway address and proxy port a preview is really served from. It applies only while the browser is still on
 * that origin: after a link leads elsewhere the name would mislabel the page, so the pill goes back to the page's own
 * title.
 */
export function browserPageLabel(
    label: string | undefined,
    initialUrl: string,
    currentUrl: string,
): string | null {
    if (!label) return null;
    const initialOrigin = parseUrl(initialUrl)?.origin;
    return initialOrigin && initialOrigin === parseUrl(currentUrl)?.origin ? label : null;
}

/**
 * The URL a remounted WebView loads. The page the reader was on, not the URL the browser opened with: a preview URL
 * carries a single-use token, so loading it again would fail. A blank or missing current page falls back to the opening
 * URL.
 */
export function browserResumeUrl(currentUrl: string, initialUrl: string): string {
    return currentUrl && !currentUrl.startsWith('about:') ? currentUrl : initialUrl;
}
