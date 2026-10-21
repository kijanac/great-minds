import { browser } from "$app/environment";

export function windowSync(events: readonly string[], sync: () => void): () => () => void {
  let listening = false;
  return () => {
    if (!browser) return () => {};
    sync();
    if (listening) return () => {};
    listening = true;
    for (const event of events) window.addEventListener(event, sync);
    return () => {
      for (const event of events) window.removeEventListener(event, sync);
      listening = false;
    };
  };
}
