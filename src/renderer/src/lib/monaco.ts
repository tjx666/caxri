import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

declare global {
    interface Window {
        MonacoEnvironment?: {
            getWorker(): Worker;
        };
    }
}

window.MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
};

loader.config({ monaco });

export { monaco };
