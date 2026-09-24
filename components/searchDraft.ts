/** Owns pending search writes so clearing cannot restore a stale query. */
export function createSearchDraft(
  commit: (value: string) => void,
  delay: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => clearTimeout(timer);
  return {
    update(value: string) {
      cancel();
      timer = setTimeout(() => commit(value.trim()), delay);
    },
    cancel,
  };
}
