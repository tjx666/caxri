import type { SourceControlResource } from 'caxri';

const MAX_ACCESSIBILITY_LABEL_LENGTH = 1_024;
const MAX_EDITOR_RESOURCE_LENGTH = 8_192;
const MAX_LABEL_LENGTH = 1_024;
const MAX_RESOURCE_PATH_LENGTH = 4_096;
const MAX_TOOLTIP_LENGTH = 4_096;

/**
 * Bounds Git-owned display projections to the public controlled Source Control contract while retaining both the
 * leading hierarchy and basename. The raw authorized path remains exclusively in opaque command arguments.
 */
function boundedSourceControlText(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    const available = maxLength - 1;
    const headLength = Math.floor(available / 2);
    return `${value.slice(0, headLength)}…${value.slice(-(available - headLength))}`;
}

export function sourceControlResourceProjection(path: string): {
    accessibilityLabel: string;
    label: string;
    path: string;
    tooltip: string;
} {
    const basename = path.split('/').findLast(Boolean) ?? path;
    return {
        accessibilityLabel: boundedSourceControlText(path, MAX_ACCESSIBILITY_LABEL_LENGTH),
        label: boundedSourceControlText(basename, MAX_LABEL_LENGTH),
        path: boundedSourceControlText(path, MAX_RESOURCE_PATH_LENGTH),
        tooltip: boundedSourceControlText(path, MAX_TOOLTIP_LENGTH),
    };
}

/**
 * An oversized URI cannot cross the generic open-editor effect contract, so it is omitted instead of invalidating the
 * view.
 */
export function boundedEditorResource(resource: string): string | undefined {
    return resource.length <= MAX_EDITOR_RESOURCE_LENGTH ? resource : undefined;
}

export function boundedActionLabel(label: string): string {
    return boundedSourceControlText(label, MAX_LABEL_LENGTH);
}

/**
 * Keeps repository-row prose inside the public Source Control snapshot bound while preserving both the branch at the
 * start and late state notices such as unpushed commits at the end.
 */
export function boundedSourceControlDescription(description: string): string {
    return boundedSourceControlText(description, MAX_TOOLTIP_LENGTH);
}

export function boundedResourceTooltip(tooltip: string): string {
    return boundedSourceControlText(tooltip, MAX_TOOLTIP_LENGTH);
}

/**
 * The resource's line counts, or nothing when the Git service did not measure the file.
 */
export function sourceControlLineStats(file: {
    additions?: number;
    deletions?: number;
}): Pick<SourceControlResource, 'lineStats'> {
    if (file.additions === undefined || file.deletions === undefined) return {};
    return { lineStats: { additions: file.additions, deletions: file.deletions } };
}
