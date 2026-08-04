import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker?worker';

declare global {
    interface Window {
        MonacoEnvironment?: {
            getWorker(moduleId: string, label: string): Worker;
        };
    }
}

window.MonacoEnvironment = {
    /** Language services require their matching worker; the generic worker lacks their RPC methods. */
    getWorker: (_moduleId: string, label: string): Worker => {
        if (label === 'json') return new JsonWorker();
        if (['css', 'less', 'scss'].includes(label)) return new CssWorker();
        if (['handlebars', 'html', 'razor'].includes(label)) return new HtmlWorker();
        if (['javascript', 'typescript'].includes(label)) return new TypeScriptWorker();
        return new EditorWorker();
    },
};

loader.config({ monaco });

export { monaco };
