import { assertEquals } from "@std/assert";
import { createSearchDraft } from "../components/searchDraft.ts";

Deno.test("search bursts commit only the final trimmed query", async () => {
  const commits: string[] = [];
  const search = createSearchDraft((value) => commits.push(value), 5);
  search.update("stale");
  search.update("  final query  ");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(commits, ["final query"]);
  search.update("   ");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(commits, ["final query", ""]);
});

Deno.test("clearing or unmounting cancels pending search writes", async () => {
  const commits: string[] = [];
  const search = createSearchDraft((value) => commits.push(value), 5);
  search.cancel();
  search.update("stale");
  search.cancel();
  search.cancel();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(commits, []);
  search.update("new query");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(commits, ["new query"]);
});

Deno.test("a query written at once is trimmed as a debounced one is, and replaces a pending one", async () => {
  const commits: string[] = [];
  const search = createSearchDraft((value) => commits.push(value), 5);
  search.update("pending");
  search.apply("  typed before  ");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(commits, ["typed before"]);
  search.apply(" ");
  assertEquals(commits, ["typed before", ""]);
});
