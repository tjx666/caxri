import { lazy, Suspense, useState } from 'react';

import type { ThemeTokens } from '@caxri/protocol';

import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import { configEditorLoadingClassName } from '../../lib/utilities';
import type { ConfigKind } from './config-edit';
import { CONFIG_FILE_NAMES } from './config-edit';
import type { ConfigSourceError } from './settings-drafts';

const ConfigEditor = lazy(async () => {
    const module = await import('./config-editor');
    return { default: module.ConfigEditor };
});

interface ConfigSourceViewProperties {
    error?: ConfigSourceError;
    kind: ConfigKind;
    source: string;
    theme: ThemeTokens;
    onBlur: () => void;
    onChange: (source: string) => void;
    onRevert: () => void;
}

/**
 * Lazy application-owned source editor for the active configuration file. Text persists when the editor loses focus
 * (see `onBlur`), not on every keystroke; a parse failure reports inline below instead of being written.
 */
export function ConfigSourceView({
    error,
    kind,
    source,
    theme,
    onBlur,
    onChange,
    onRevert,
}: ConfigSourceViewProperties) {
    const { t } = useTranslation();
    const fileName = CONFIG_FILE_NAMES[kind];
    const [goToLineRequest, setGoToLineRequest] = useState<{ line: number }>();
    const errorLine = error?.line;
    return (
        <div
            className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden"
            data-config-source={kind}
        >
            <Suspense fallback={<div className={configEditorLoadingClassName} />}>
                <ConfigEditor
                    ariaLabel={t('settings.source.editorLabel', { fileName })}
                    path={`/caxri/${fileName}`}
                    theme={theme}
                    value={source}
                    onBlur={onBlur}
                    onChange={onChange}
                    goToLineRequest={goToLineRequest}
                />
            </Suspense>
            {error && (
                <div
                    role="alert"
                    className="flex items-center gap-3 border-t border-danger bg-surface px-3 py-2 text-[11px] text-danger"
                >
                    <span className="min-w-0 flex-1">{error.error}</span>
                    <div className="flex shrink-0 items-center gap-1">
                        {errorLine !== undefined && (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setGoToLineRequest({ line: errorLine })}
                            >
                                {t('settings.source.goToLine', { line: errorLine })}
                            </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={onRevert}>
                            {t('settings.source.revert')}
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
