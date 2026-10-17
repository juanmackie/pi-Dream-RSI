export function parseQuery(query) {
  const output = new Map();
  for (const segment of query.split("&")) {
    if (segment === "") continue;
    const [key, value = ""] = segment.split("=");
    if (!output.has(key)) output.set(key, []);
    output.get(key).push(value);
  }
  return output;
}
