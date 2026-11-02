/**
 * Metro resolves a bundled image to an opaque asset ID that `Image` accepts as its `source`.
 */
declare module '*.png' {
    const asset: number;
    export default asset;
}
