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

export function isSecurePage(url: string): boolean {
    return parseUrl(url)?.protocol === 'https:';
}
