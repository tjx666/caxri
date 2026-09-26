export async function didUploadImageChunks(
    chunks: string[],
    sendChunk: (index: number, chunk: string, count: number) => Promise<void>,
    isCancelled: () => boolean,
    onProgress: (progress: number) => void,
): Promise<boolean> {
    const didSendNext = async (index: number): Promise<boolean> => {
        if (index >= chunks.length) return true;
        if (isCancelled()) return false;
        // The Server assembles chunks in order for one attachment ID.
        await sendChunk(index, chunks[index], chunks.length);
        onProgress((index + 1) / chunks.length);
        return didSendNext(index + 1);
    };
    return didSendNext(0);
}
