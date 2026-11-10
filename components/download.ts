/** How long a download's object URL outlives the click that used it. */
const REVOKE_AFTER_MS = 40_000;

/** Hands a generated file to the browser as a download. Browser-only. */
export function saveDownload(
  name: string,
  data: Uint8Array | string,
  type: string,
): void {
  // A Uint8Array's buffer types as ArrayBufferLike, which BlobPart no longer
  // admits; every array reaching here sits on a plain ArrayBuffer.
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // Safari and Firefox abort a download whose object URL is revoked in the
  // same task as the click, and Safari reads the blob from another process
  // some time after it: the next task is not late enough there. The wait is
  // FileSaver.js's, and all it holds is one file's bytes until it ends.
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}
