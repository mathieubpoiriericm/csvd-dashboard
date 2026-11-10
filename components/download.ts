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
  // same task as the click, so the revoke waits for the next one.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
