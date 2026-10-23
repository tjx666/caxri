/**
 * Runs the `@vscode/vscode-languagedetection` model off the Renderer's main thread. Only the package's model files are
 * used: its JavaScript entry is a Node-targeted bundle that `require`s `fs`, so this Worker loads the graph model with
 * TensorFlow.js directly, as the package's own `ModelOperations.runModel` does.
 *
 * TensorFlow.js stays on 3.x: the model was converted by TFJS Converter 3.7, and 4.x fails inside its `reshape` kernel
 * while executing it. The CPU backend is enough for a model this small (a few milliseconds per run) and avoids a WebGL
 * context in the Worker.
 *
 * The weights are an inline module because the packaged Renderer is a `file://` page whose CSP lets it fetch nothing
 * from the application (docs/bundle-size.md); they load with this Worker, which starts only when an untitled buffer
 * first needs detection.
 */
import '@tensorflow/tfjs-backend-cpu';

import { disposeAll } from '@caxri/utils';
import type { GraphModel } from '@tensorflow/tfjs-converter';
import { loadGraphModel } from '@tensorflow/tfjs-converter';
import type { io } from '@tensorflow/tfjs-core';
import { setBackend, tensor } from '@tensorflow/tfjs-core';
import weightsDataUrl from '@vscode/vscode-languagedetection/model/group1-shard1of1.bin?inline';
import modelJson from '@vscode/vscode-languagedetection/model/model.json';

import type { DetectedLanguage } from './language-detection';

export interface LanguageDetectionRequest {
    id: number;
    content: string;
}

export type LanguageDetectionResponse =
    { id: number; results: DetectedLanguage[] } | { id: number; error: string };

function decodeDataUrl(dataUrl: string): ArrayBuffer {
    const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1)
        bytes[index] = binary.codePointAt(index) ?? 0;
    return bytes.buffer;
}

const model: { promise?: Promise<GraphModel> } = {};

async function loadModel(): Promise<GraphModel> {
    await setBackend('cpu');
    const artifacts: io.ModelArtifacts = {
        modelTopology: modelJson.modelTopology,
        format: modelJson.format,
        generatedBy: modelJson.generatedBy,
        convertedBy: modelJson.convertedBy,
        // The signature names both outputs (scores and classes); without it the graph runs to its default output only.
        signature: modelJson.signature,
        modelInitializer: modelJson.modelInitializer,
        weightSpecs: modelJson.weightsManifest.flatMap((manifest) => manifest.weights),
        weightData: decodeDataUrl(weightsDataUrl),
    } as io.ModelArtifacts;
    return loadGraphModel({ load: () => Promise.resolve(artifacts) });
}

async function detect(content: string): Promise<DetectedLanguage[]> {
    model.promise ??= loadModel();
    const graph = await model.promise;
    const input = tensor([content.replaceAll('\r\n', '\n')]);
    const output = await graph.executeAsync(input);
    input.dispose();
    const outputs = Array.isArray(output) ? output : [output];
    // Told apart by type rather than position, so the result never depends on the signature's output order.
    const languages = outputs.find((candidate) => candidate.dtype === 'string');
    const probabilities = outputs.find((candidate) => candidate.dtype !== 'string');
    if (!languages || !probabilities) {
        disposeAll(outputs);
        throw new Error('Language detection model returned an unexpected output');
    }
    const confidence = probabilities.dataSync();
    const languageIds = languages.dataSync() as unknown as ArrayLike<string>;
    disposeAll(outputs);
    return Array.from(languageIds, (languageId, index) => ({
        languageId,
        confidence: confidence[index] ?? 0,
    })).toSorted((left, right) => right.confidence - left.confidence);
}

addEventListener('message', async (event: MessageEvent<LanguageDetectionRequest>) => {
    const { id, content } = event.data;
    try {
        postMessage({ id, results: await detect(content) } satisfies LanguageDetectionResponse);
    } catch (error) {
        postMessage({
            id,
            error: error instanceof Error ? error.message : String(error),
        } satisfies LanguageDetectionResponse);
    }
});
