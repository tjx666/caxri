import { Suspense, lazy } from 'react';

import type { ThemeTokens } from '@shared/types';

import { configurationEditorLoadingClassName } from '../../lib/utils';
import { CONFIG_FILE_NAMES, type ConfigKind } from './config-edit';

const ConfigurationEditor = lazy(async () => {
    const module = await import('./configuration-editor');
    return { default: module.ConfigurationEditor };
});

interface ConfigurationSourceViewProps {
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
export function ConfigurationSourceView({
    error,
    kind,
    source,
    theme,
    onBlur,
    onChange,
}: ConfigurationSourceViewProps) {
    const fileName = CONFIG_FILE_NAMES[kind];
    return (
        <div
            className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden"
            data-config-source={kind}
        >
            <Suspense fallback={<div className={configurationEditorLoadingClassName} />}>
                <ConfigurationEditor
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
