/**
 * Looks up `#id` and throws unless it is actually an instance of `ctor` --
 * a real runtime check (rather than an unchecked type-assertion cast, which
 * project rules forbid) so a wrong id/element-type pairing in the markup
 * above throws a clear error immediately instead of silently producing a
 * mistyped reference that fails confusingly later (e.g. `.value` on a `<div>`).
 */
export function requireElementOfType<T extends HTMLElement>(id: string, ctor: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof ctor)) {
    throw new Error(`Missing or mistyped #${id} element (expected ${ctor.name})`);
  }
  return element;
}

export function clearChildren(element: Element): void {
  element.replaceChildren();
}

export function renderMessage(container: Element, text: string, kind: "error" | "pending" | "info"): void {
  clearChildren(container);
  const paragraph = document.createElement("p");
  paragraph.className = `message message-${kind}`;
  paragraph.textContent = text;
  container.append(paragraph);
}
