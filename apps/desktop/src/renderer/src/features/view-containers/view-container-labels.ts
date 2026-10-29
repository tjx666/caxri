import type { ControlledViewPresentation } from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';

/**
 * The view catalog arrives from the Server with English titles: the built-in panel containers (`apps/server`'s
 * catalog), the Files core contribution (`@caxri/protocol`), and the bundled Git and Status extensions' manifests.
 * Their ids are reserved for those owners, so the Renderer translates them at display time by id. Any other container
 * or view is extension-contributed and keeps the title its manifest provides. `Git` is a product name and stays as is.
 */
const CONTAINER_TITLE_KEYS: Readonly<Record<string, TranslationKey>> = {
    'caxri.files': 'viewContainers.builtin.files',
    'caxri.info': 'viewContainers.builtin.info',
    'caxri.logs': 'viewContainers.builtin.logs',
    'caxri.project-status': 'viewContainers.builtin.status',
};

const VIEW_TITLE_KEYS: Readonly<Record<string, TranslationKey>> = {
    'caxri.files.explorer': 'viewContainers.builtin.files',
    'caxri.git.sourceControl': 'viewContainers.sourceControl.title',
    'caxri.info.view': 'viewContainers.builtin.info',
    'caxri.logs.view': 'viewContainers.builtin.logs',
    'caxri.project-status.overview': 'viewContainers.builtin.projectStatus',
};

/**
 * The bundled Git extension's `presentation` copy, keyed by the same fields.
 */
const VIEW_PRESENTATION_KEYS: Readonly<
    Record<string, Record<keyof ControlledViewPresentation, TranslationKey>>
> = {
    'caxri.git.sourceControl': {
        actionErrorMessage: 'viewContainers.builtin.gitActionFailed',
        loadingMessage: 'viewContainers.sourceControl.loading',
        noContextMessage: 'viewContainers.sourceControl.noSessionHint',
        refreshErrorMessage: 'viewContainers.builtin.gitRefreshFailed',
    },
};

function lookup(
    keys: Readonly<Record<string, TranslationKey>>,
    id: string,
): TranslationKey | undefined {
    return Object.hasOwn(keys, id) ? keys[id] : undefined;
}

/**
 * A container's tab title in the interface language.
 */
export function viewContainerTitle(container: { id: string; title: string }, t: Translate): string {
    const key = lookup(CONTAINER_TITLE_KEYS, container.id);
    return key ? t(key) : container.title;
}

/**
 * A view's caption in the interface language.
 */
export function viewTitle(view: { id: string; title: string }, t: Translate): string {
    const key = lookup(VIEW_TITLE_KEYS, view.id);
    return key ? t(key) : view.title;
}

/**
 * A controlled view's status copy in the interface language; an extension's own copy passes through unchanged.
 */
export function viewPresentation(
    viewId: string,
    presentation: ControlledViewPresentation | undefined,
    t: Translate,
): ControlledViewPresentation | undefined {
    const keys = Object.hasOwn(VIEW_PRESENTATION_KEYS, viewId)
        ? VIEW_PRESENTATION_KEYS[viewId]
        : undefined;
    if (!presentation || !keys) return presentation;
    return {
        actionErrorMessage: t(keys.actionErrorMessage),
        loadingMessage: t(keys.loadingMessage),
        noContextMessage: t(keys.noContextMessage),
        refreshErrorMessage: t(keys.refreshErrorMessage),
    };
}
