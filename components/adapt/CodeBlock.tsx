/** Genuine code or a command; the one place --svd-font-mono is right. */
export function CodeBlock({ children }: { children: string }) {
  return <pre class="code-block">{children}</pre>;
}
