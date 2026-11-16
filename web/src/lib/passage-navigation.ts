export function passageMark(threadId: string, root: ParentNode = document): HTMLElement | null {
  const selector = `mark[data-thread-id="${CSS.escape(threadId)}"]`;
  return (
    root.querySelector<HTMLElement>(`${selector}[role="button"]`) ??
    root.querySelector<HTMLElement>(selector)
  );
}

export function revealPassage(element: HTMLElement): void {
  element.scrollIntoView({ block: "center" });
  if (!element.hasAttribute("tabindex")) element.tabIndex = -1;
  element.focus({ preventScroll: true });
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  element.animate(
    {
      outlineColor: [getComputedStyle(element).getPropertyValue("--gold"), "transparent"],
      outlineStyle: ["solid", "solid"],
      outlineWidth: ["2px", "2px"],
      outlineOffset: ["3px", "3px"],
    },
    { duration: 1800, easing: "ease-out" },
  );
}

export function arriveAt(hash: string): void {
  document.querySelector("[data-arrived]")?.removeAttribute("data-arrived");
  const target = document.getElementById(decodeURIComponent(hash.slice(1)));
  const block = target?.matches("span:empty") ? target.parentElement : target;
  if (!block) return;
  block.scrollIntoView({ block: "start" });
  block.setAttribute("data-arrived", "");
}
