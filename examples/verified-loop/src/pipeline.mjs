export function buildReport(count) {
  const parts = [];
  for (let index = 0; index < count; index += 1) parts.push(`item-${index};`);
  let checksum = 0;
  for (let index = 0; index < count; index += 1) {
    for (let inner = 0; inner <= index; inner += 1) checksum += parts[inner].length;
  }
  return parts.join("") + "#" + checksum;
}
