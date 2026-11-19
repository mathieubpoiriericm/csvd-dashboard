/**
 * Owns pending search writes so clearing cannot restore a stale query, and
 * trims every query it writes, debounced or at once.
 */
export function createSearchDraft(
  commit: (value: string) => void,
  delay: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => clearTimeout(timer);
  const write = (value: string) => commit(value.trim());
  return {
    update(value: string) {
      cancel();
      timer = setTimeout(() => write(value), delay);
    },
    /** Writes a query at once, in place of any still pending. */
    apply(value: string) {
      cancel();
      write(value);
    },
    cancel,
  };
}
