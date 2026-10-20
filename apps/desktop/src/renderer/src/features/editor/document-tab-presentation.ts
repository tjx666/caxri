import {
    parseExternalEditorTab,
    parseFilePreviewTab,
    virtualEditorTabScheme,
} from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import type { VirtualTabPresentationOptions } from './virtual-tab-descriptors';
import { virtualTabDescriptors } from './virtual-tab-descriptors';

function directorySegments(displayPath: string): string[] {
    return displayPath.split('/').slice(0, -1).filter(Boolean);
}

/**
 * The shortest trailing run of parent directories that tells `displayPath` apart from every other open external file
 * with the same name, or `undefined` when its name is unique. Mirrors VS Code's tab descriptions: a lone `README.md`
 * stays bare, two of them read `api` and `web`, and deeper collisions widen to `packages/api`.
 */
export function externalTabParentLabel(
    displayPath: string,
    externalDisplayPaths: readonly string[],
): string | undefined {
    const name = pathBasename(displayPath);
    const others = [...new Set(externalDisplayPaths)]
        .filter((other) => other !== displayPath && pathBasename(other) === name)
        .map(directorySegments);
    if (others.length === 0) return undefined;
    const own = directorySegments(displayPath);
    for (let depth = 1; depth <= own.length; depth += 1) {
        const suffix = own.slice(-depth).join('/');
        if (others.every((segments) => segments.slice(-depth).join('/') !== suffix)) return suffix;
    }
    return own.length > 0 ? `/${own.join('/')}` : '/';
}

/**
 * Keeps resource labels and filesystem hover paths consistent without branching inside tab rendering. A virtual tab's
 * label, icon, and tooltip come from its scheme's entry in `virtualTabDescriptors`; only a Project file is described
 * here.
 */
export function documentTabPresentation(
    path: string,
    options: VirtualTabPresentationOptions & {
        /**
         * Display paths of every external document open in the same Session, so an external tab whose filename repeats
         * can show the parent directory that tells it apart.
         */
        externalDisplayPaths?: readonly string[];
    },
    t: Translate = translate,
) {
    const scheme = virtualEditorTabScheme(path);
    const external = parseExternalEditorTab(path);
    const preview = parseFilePreviewTab(path);
    const previewExternal = preview ? parseExternalEditorTab(preview.path) : undefined;
    const presentation = scheme
        ? virtualTabDescriptors[scheme].present(path, options, t)
        : {
              icon: 'file' as const,
              fileIconName: pathBasename(path),
              label: pathBasename(path),
              labelTooltip: options.displayPath ?? path,
          };
    const isOutsideProject = Boolean(external) || Boolean(previewExternal);
    const detail =
        external && options.displayPath
            ? externalTabParentLabel(options.displayPath, options.externalDisplayPaths ?? [])
            : undefined;
    return {
        /**
         * Spoken after the label (never replacing it): the tab is a file outside every Project.
         */
        ...(isOutsideProject && { accessibleDetail: t('editor.tab.outsideProject') }),
        /**
         * Muted parent directory shown beside a repeated external filename, the way VS Code tells same-named tabs
         * apart.
         */
        ...(detail && { detail }),
        ...presentation,
    };
}
