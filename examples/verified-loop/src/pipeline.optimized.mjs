export function buildReport(count) {
  const parts = [];
  let checksum = 0;
  let available = 0;
  for (let index = 0; index < count; index += 1) {
    const item = `item-${index};`;
    parts.push(item);
    available += item.length;
    checksum += available;
  }
  return parts.join("") + "#" + checksum;
}
