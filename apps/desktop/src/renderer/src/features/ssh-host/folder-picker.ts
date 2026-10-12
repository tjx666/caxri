/**
 * Path helpers for the SSH Host folder picker. The listed folders live on a Linux SSH Host, so every path here is a
 * POSIX path regardless of the Mac's own conventions.
 */

export interface FolderBreadcrumb {
    label: string;
    path: string;
}

function trimTrailingSlashes(path: string): string {
    const trimmed = path.replace(/\/+$/u, '');
    return trimmed === '' ? '/' : trimmed;
}

/**
 * Resolves what the user typed into an absolute path: `~` and `~/…` expand against the SSH Host's home folder, an
 * absolute path is kept, and anything else (a relative path, `~user`) is refused because there is no current folder the
 * user would agree it is relative to.
 */
export function resolveFolderInput(input: string, home: string): string | undefined {
    const value = input.trim();
    if (value === '~') return trimTrailingSlashes(home);
    if (value.startsWith('~/'))
        return trimTrailingSlashes(`${trimTrailingSlashes(home)}/${value.slice(2)}`);
    if (value.startsWith('/')) return trimTrailingSlashes(value.replaceAll(/\/{2,}/gu, '/'));
    return undefined;
}

/**
 * Splits an absolute folder into clickable ancestors. Inside the home folder the trail starts at `~`, which is both
 * shorter and how the user already thinks of those paths; elsewhere it starts at `/`.
 */
export function folderBreadcrumbs(path: string, home: string): FolderBreadcrumb[] {
    const normalizedHome = trimTrailingSlashes(home);
    const normalizedPath = trimTrailingSlashes(path);
    const isUnderHome =
        normalizedHome !== '/' &&
        (normalizedPath === normalizedHome || normalizedPath.startsWith(`${normalizedHome}/`));
    const root: FolderBreadcrumb = isUnderHome
        ? { label: '~', path: normalizedHome }
        : { label: '/', path: '/' };
    const rest = isUnderHome
        ? normalizedPath.slice(normalizedHome.length)
        : normalizedPath === '/'
          ? ''
          : normalizedPath;
    const crumbs = [root];
    let current = root.path === '/' ? '' : root.path;
    for (const segment of rest.split('/')) {
        if (!segment) continue;
        current += `/${segment}`;
        crumbs.push({ label: segment, path: current });
    }
    return crumbs;
}

/**
 * The path as the input field shows it: `~`-relative inside the home folder.
 */
export function displayFolderPath(path: string, home: string): string {
    const crumbs = folderBreadcrumbs(path, home);
    if (crumbs[0]?.label !== '~') return trimTrailingSlashes(path);
    return ['~', ...crumbs.slice(1).map((crumb) => crumb.label)].join('/');
}
