/**
 * How an approval card names a path. A long absolute path truncated at its tail hides the part that matters (the folder
 * or file the Agent touches), so the card shows the path relative to the Project root when it lies inside it, else its
 * last two segments. The full path stays in the accessibility label.
 */
export const agentChatRequestPathLabel = (path: string, projectRoot?: string): string => {
    const separator = path.includes('\\') && !path.includes('/') ? '\\' : '/';
    const isAbsolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path);
    if (!isAbsolute) return path;
    const segments = path.split(/[\\/]+/u).filter(Boolean);
    const rootSegments = projectRoot?.split(/[\\/]+/u).filter(Boolean) ?? [];
    const isInsideRoot =
        rootSegments.length > 0 &&
        segments.length >= rootSegments.length &&
        rootSegments.every((segment, index) => segment === segments[index]);
    if (isInsideRoot) {
        const relative = segments.slice(rootSegments.length);
        return relative.length === 0 ? '.' : relative.join(separator);
    }
    if (segments.length <= 2) return path;
    return `…${separator}${segments.slice(-2).join(separator)}`;
};
