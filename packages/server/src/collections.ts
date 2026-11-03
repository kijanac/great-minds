export const append = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
};
