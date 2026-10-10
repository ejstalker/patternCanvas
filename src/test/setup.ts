import 'fake-indexeddb/auto';

// jsdom implements no object URLs, and the persistence layer hands image blobs
// out as object URLs. Without these the asset round trip cannot be exercised at
// all — which is how a save that dropped image bytes went unnoticed.
if (typeof URL.createObjectURL !== 'function') {
  const made = new Map<string, Blob>();
  let next = 0;
  URL.createObjectURL = (obj: Blob | MediaSource) => {
    const url = `blob:test/${++next}`;
    made.set(url, obj as Blob);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    made.delete(url);
  };
}
