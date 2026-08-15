import { lazy, Suspense } from 'react';

import type { ThemeTokens } from '@shared/types';

import { configEditorLoadingClassName } from '../../lib/utilities';
import type { ConfigKind } from './config-edit';
import { CONFIG_FILE_NAMES } from './config-edit';

const ConfigEditor = lazy(async () => {
    const module = await import('./config-editor');
    return { default: module.ConfigEditor };
});

interface ConfigSourceViewProperties {
    error?: string;
    kind: ConfigKind;
    source: string;
    theme: ThemeTokens;
    onBlur: () => void;
    onChange: (source: string) => void;
}

/**
 * Lazy application-owned source editor for the active configuration file. Text persists when the
 * editor loses focus (see `onBlur`), not on every keystroke; a parse failure reports inline below
 * instead of being written.
 */
export function ConfigSourceView({
    error,
    kind,
    source,
    theme,
    onBlur,
    onChange,
}: ConfigSourceViewProperties) {
    const fileName = CONFIG_FILE_NAMES[kind];
    return (
        <div
            className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden"
            data-config-source={kind}
        >
            <Suspense fallback={<div className={configEditorLoadingClassName} />}>
                <ConfigEditor
                    ariaLabel={`${fileName} source`}
                    path={`/caxri/${fileName}`}
                    theme={theme}
                    value={source}
                    onBlur={onBlur}
                    onChange={onChange}
                />
            </Suspense>
            {error && (
                <div
                    role="alert"
                    className="border-t border-danger bg-surface px-3 py-2 text-[11px] text-danger"
                >
                    {error}
                </div>
            )}
        </div>
    );
}
