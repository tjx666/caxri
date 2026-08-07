import Editor from '@monaco-editor/react';
import { useEffect } from 'react';

import type { ThemeTokens } from '@shared/types';

import { applyEditorTheme } from '../../lib/editor-theme';
import { configurationEditorClassName } from '../../lib/utils';

interface ConfigurationEditorProps {
    ariaLabel: string;
    path: string;
    theme: ThemeTokens;
    value: string;
    onChange: (value: string) => void;
}

export function ConfigurationEditor({
    ariaLabel,
    path,
    theme,
    value,
    onChange,
}: ConfigurationEditorProps) {
    useEffect(() => applyEditorTheme(theme), [theme]);

    return (
        <div className={configurationEditorClassName} aria-label={ariaLabel}>
            <Editor
                path={path}
                language="json"
                value={value}
                theme="caxri-active"
                beforeMount={() => applyEditorTheme(theme)}
                onChange={(next) => onChange(next ?? '')}
                options={{
                    automaticLayout: true,
                    fontSize: 12,
                    lineNumbersMinChars: 3,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    tabSize: 2,
                    wordWrap: 'on',
                }}
            />
        </div>
    );
}
