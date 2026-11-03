/**
 * The `drive-app` steps that answer Main's native dialogs. Main has no page target, so each stub goes through its Node
 * inspector; `includeCommandLineAPI` exposes `require` there, as `e2e/support/packaged-project-dialog.ts` gets `dialog`
 * through Playwright's Electron handle. Each stub replaces the dialog method until the dev instance exits.
 */
import { connectToNodeInspector } from './cdp-client';

async function evaluateInMain(inspectorPort: number, expression: string): Promise<void> {
    const connection = await connectToNodeInspector(inspectorPort);
    try {
        const result = await connection.request<{ exceptionDetails?: { text: string } }>(
            'Runtime.evaluate',
            { expression, includeCommandLineAPI: true },
        );
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    } finally {
        connection.close();
    }
}

/**
 * Makes Main's native folder picker return `folder`.
 */
export function stubFolderDialog(inspectorPort: number, folder: string): Promise<void> {
    return evaluateInMain(
        inspectorPort,
        `(() => {
            const { dialog } = require('electron');
            dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [${JSON.stringify(folder)}] });
        })()`,
    );
}

/**
 * Makes every Main confirmation (`dialog.showMessageBox`) answer with the button at `response`, as if the user picked
 * it. The real box never opens, so a prompt's own copy is verified by unit tests on its prompt builder instead.
 */
export function stubMessageBox(inspectorPort: number, response: number): Promise<void> {
    return evaluateInMain(
        inspectorPort,
        `(() => {
            const { dialog } = require('electron');
            dialog.showMessageBox = () => Promise.resolve({ response: ${response}, checkboxChecked: false });
        })()`,
    );
}
