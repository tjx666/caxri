import type {
    SourceControlAction,
    SourceControlActionEffect,
    SourceControlHistoryDescriptor,
    SourceControlViewModel,
} from '@caxri/protocol';

import type { Translate } from '../../../i18n';
import { localizeExtensionParts, localizeExtensionText } from '../extension-text';

type Provider = SourceControlViewModel['providers'][number];
type Group = Provider['groups'][number];
type Resource = Group['resources'][number];

/**
 * Translates the chrome the bundled Git extension sent in English (see `extension-text.ts`). Data fields (repository
 * names, branch names, file paths, commit subjects) are never passed through the catalog; only labels, captions, empty
 * states, and tooltips are.
 */
function localizeSourceControlAction(
    action: SourceControlAction,
    t: Translate,
): SourceControlAction {
    return {
        ...action,
        label: localizeExtensionText(action.label, t),
        ...(action.accessibilityLabel !== undefined && {
            accessibilityLabel: localizeExtensionText(action.accessibilityLabel, t),
        }),
        ...(action.tooltip !== undefined && { tooltip: localizeExtensionText(action.tooltip, t) }),
        ...(action.progressLabel !== undefined && {
            progressLabel: localizeExtensionText(action.progressLabel, t),
        }),
        ...(action.errorMessage !== undefined && {
            errorMessage: localizeExtensionText(action.errorMessage, t),
        }),
    };
}

function localizeSourceControlHistoryDescriptor(
    descriptor: SourceControlHistoryDescriptor,
    t: Translate,
): SourceControlHistoryDescriptor {
    const text = (value: string) => localizeExtensionText(value, t);
    return {
        ...descriptor,
        label: text(descriptor.label),
        pathInputLabel: text(descriptor.pathInputLabel),
        pathInputPlaceholder: text(descriptor.pathInputPlaceholder),
        clearPathLabel: text(descriptor.clearPathLabel),
        loadingMessage: text(descriptor.loadingMessage),
        emptyMessage: text(descriptor.emptyMessage),
        loadMoreLabel: text(descriptor.loadMoreLabel),
        loadingMoreLabel: text(descriptor.loadingMoreLabel),
        loadErrorMessage: text(descriptor.loadErrorMessage),
        detailsLoadingMessage: text(descriptor.detailsLoadingMessage),
        detailsErrorMessage: text(descriptor.detailsErrorMessage),
        detailsLabel: text(descriptor.detailsLabel),
        detailsEmptyMessage: text(descriptor.detailsEmptyMessage),
        detailsTruncatedMessage: text(descriptor.detailsTruncatedMessage),
        itemAccessibilityLabelPrefix: text(descriptor.itemAccessibilityLabelPrefix),
    };
}

function localizeResource(resource: Resource, t: Translate): Resource {
    return {
        ...resource,
        ...(resource.action && { action: localizeSourceControlAction(resource.action, t) }),
        ...(resource.actions && {
            actions: resource.actions.map((action) => localizeSourceControlAction(action, t)),
        }),
    };
}

function localizeGroup(group: Group, t: Translate): Group {
    return {
        ...group,
        label: localizeExtensionText(group.label, t),
        emptyMessage: localizeExtensionText(group.emptyMessage, t),
        ...(group.truncationMessage !== undefined && {
            truncationMessage: localizeExtensionText(group.truncationMessage, t),
        }),
        actions: group.actions.map((action) => localizeSourceControlAction(action, t)),
        resources: group.resources.map((resource) => localizeResource(resource, t)),
    };
}

function localizeProvider(provider: Provider, t: Translate): Provider {
    return {
        ...provider,
        ...(provider.kindLabel !== undefined && {
            kindLabel: localizeExtensionText(provider.kindLabel, t),
        }),
        description: localizeExtensionText(provider.description, t),
        ...(provider.descriptionBadge !== undefined && {
            descriptionBadge: localizeExtensionText(provider.descriptionBadge, t),
        }),
        descriptionAccessibilityLabel: localizeExtensionParts(
            provider.descriptionAccessibilityLabel,
            t,
        ),
        descriptionTooltip: localizeExtensionParts(provider.descriptionTooltip, t),
        countLabel: localizeExtensionParts(provider.countLabel, t),
        ...(provider.externalLink && {
            externalLink: {
                ...provider.externalLink,
                label: localizeExtensionText(provider.externalLink.label, t),
            },
        }),
        ...(provider.uncommittedNotice && {
            uncommittedNotice: {
                ...provider.uncommittedNotice,
                accessibilityLabel: localizeExtensionText(
                    provider.uncommittedNotice.accessibilityLabel,
                    t,
                ),
                tooltip: localizeExtensionText(provider.uncommittedNotice.tooltip, t),
            },
        }),
        actions: provider.actions.map((action) => localizeSourceControlAction(action, t)),
        groups: provider.groups.map((group) => localizeGroup(group, t)),
        ...(provider.history && {
            history: localizeSourceControlHistoryDescriptor(provider.history, t),
        }),
    };
}

/**
 * The Source Control model in the interface language. Returns a new model; the raw one stays the source of truth for
 * action resolution, which matches by command binding and never by label.
 */
export function localizeSourceControlModel(
    model: SourceControlViewModel,
    t: Translate,
): SourceControlViewModel {
    return {
        ...model,
        title: localizeExtensionText(model.title, t),
        accessibilityLabel: localizeExtensionText(model.accessibilityLabel, t),
        modeAccessibilityLabel: localizeExtensionText(model.modeAccessibilityLabel, t),
        modes: model.modes.map((mode) => ({
            ...mode,
            label: localizeExtensionText(mode.label, t),
        })),
        refreshAction: localizeSourceControlAction(model.refreshAction, t),
        ...(model.headerActions && {
            headerActions: model.headerActions.map((action) =>
                localizeSourceControlAction(action, t),
            ),
        }),
        ...(model.fileHistory && {
            fileHistory: {
                ...model.fileHistory,
                label: localizeExtensionText(model.fileHistory.label, t),
                emptyMessage: localizeExtensionText(model.fileHistory.emptyMessage, t),
                history: localizeSourceControlHistoryDescriptor(model.fileHistory.history, t),
            },
        }),
        providers: model.providers.map((provider) => localizeProvider(provider, t)),
        ...(model.emptyMessage !== undefined && {
            emptyMessage: localizeExtensionText(model.emptyMessage, t),
        }),
        ...(model.truncationMessage !== undefined && {
            truncationMessage: localizeExtensionText(model.truncationMessage, t),
        }),
    };
}

/**
 * A history details summary (`3 files changed+ · 1 hidden`): the Git extension appends `+` to a truncated count.
 */
export function localizeHistorySummary(summary: string, t: Translate): string {
    return summary
        .split(' · ')
        .map((part) => {
            const isTruncated = part.endsWith('+');
            const translated = localizeExtensionText(isTruncated ? part.slice(0, -1) : part, t);
            return isTruncated && translated !== part.slice(0, -1) ? `${translated}+` : translated;
        })
        .join(' · ');
}

/**
 * A toast the Git extension raised after an action (`Synced with remote`).
 */
export function localizeActionEffect(
    effect: SourceControlActionEffect,
    t: Translate,
): SourceControlActionEffect {
    return effect.kind === 'toast'
        ? { ...effect, message: localizeExtensionText(effect.message, t) }
        : effect;
}
