import { assertEquals } from "@std/assert";

import { bindCircleMarkerAccessibility } from "../islands/TrialsMap.tsx";

class MarkerPath extends EventTarget {
  readonly attributes = new Map<string, string>();

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
}

function keyboardEvent(key: string): Event {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  return event;
}

Deno.test("circle-marker paths are named and keyboard-operable", () => {
  const path = new MarkerPath();
  let popupOpens = 0;
  const binding = bindCircleMarkerAccessibility(
    path,
    "Open facility details: Hôpital Lariboisière — NCT00000001",
    () => popupOpens++,
  );

  assertEquals(path.attributes.get("tabindex"), "0");
  assertEquals(path.attributes.get("role"), "button");
  assertEquals(
    path.attributes.get("aria-label"),
    "Open facility details: Hôpital Lariboisière — NCT00000001",
  );
  assertEquals(path.attributes.get("aria-expanded"), "false");

  const arrow = keyboardEvent("ArrowRight");
  path.dispatchEvent(arrow);
  assertEquals(popupOpens, 0);
  assertEquals(arrow.defaultPrevented, false);

  const enter = keyboardEvent("Enter");
  path.dispatchEvent(enter);
  assertEquals(popupOpens, 1);
  assertEquals(enter.defaultPrevented, true);

  const space = keyboardEvent(" ");
  path.dispatchEvent(space);
  assertEquals(popupOpens, 2);
  assertEquals(space.defaultPrevented, true);

  binding.setExpanded(true);
  assertEquals(path.attributes.get("aria-expanded"), "true");
  binding.setExpanded(false);
  assertEquals(path.attributes.get("aria-expanded"), "false");

  binding.dispose();
  path.dispatchEvent(keyboardEvent("Enter"));
  assertEquals(popupOpens, 2);
});
