import { useRef } from "react";

// Stable ref that always reads the latest value. Use when a callback or value
// needs to be readable from a memoized closure (e.g. useMemo with empty deps)
// without invalidating the closure when the value changes. Do not use for
// callbacks called inside useEffect — useEffectEvent fits that case better.
//
// Pattern: https://www.epicreact.dev/the-latest-ref-pattern-in-react
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
