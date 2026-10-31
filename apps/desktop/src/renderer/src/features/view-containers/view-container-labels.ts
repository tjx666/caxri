import type { Translate, TranslationKey } from '../../i18n';

/**
 * The built-in panel containers (`apps/server`'s catalog) and the Files core contribution (`@caxri/protocol`) arrive
 * with English titles. Their ids are reserved for those owners, so the Renderer translates them at display time by id.
 * Extension-contributed containers and views, the bundled Git and Status extensions included, arrive already in the
 * interface language through their manifest's `package.nls` files and keep that title.
 */
const CONTAINER_TITLE_KEYS: Readonly<Record<string, TranslationKey>> = {
    'caxri.files': 'viewContainers.builtin.files',
    'caxri.info': 'viewContainers.builtin.info',
    'caxri.logs': 'viewContainers.builtin.logs',
};

const VIEW_TITLE_KEYS: Readonly<Record<string, TranslationKey>> = {
    'caxri.files.explorer': 'viewContainers.builtin.files',
    'caxri.info.view': 'viewContainers.builtin.info',
    'caxri.logs.view': 'viewContainers.builtin.logs',
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
