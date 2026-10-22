/**
 * What a Session row shows after its title: the collision suffix and, in the Pinned group, the owning Project name.
 */
export interface SessionRowDetail {
    /**
     * Whether the trailing Project name is shown (only in the Pinned group, and only when the suffix does not already
     * carry it).
     */
    showProjectName: boolean;
    suffix?: string;
}

/**
 * The collision suffix escalates to the Project name when same-titled Sessions span Projects ("proj-a · #4"). A row
 * must name its Project once:
 *
 * - Pinned group (`isInPinnedGroup`): the suffix already names it, so the trailing Project name is dropped.
 * - Ordinary Project group: every row sits under its own Project heading, so the Project part is stripped.
 */
export function sessionRowDetail(
    suffix: string | undefined,
    projectTitle: string,
    isInPinnedGroup: boolean,
): SessionRowDetail {
    const separator = ' · ';
    let rest = suffix;
    let isCarriesProject = false;
    if (suffix !== undefined && projectTitle !== '') {
        if (suffix === projectTitle) {
            rest = undefined;
            isCarriesProject = true;
        } else if (suffix.startsWith(projectTitle + separator)) {
            rest = suffix.slice(projectTitle.length + separator.length);
            isCarriesProject = true;
        }
    }
    if (isInPinnedGroup) return { showProjectName: !isCarriesProject, suffix };
    return { showProjectName: false, suffix: rest === '' ? undefined : rest };
}
