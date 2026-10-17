export function createLookup(entries) {
  return (key) => {
    let comparisons = 0;
    for (const [candidate, value] of entries) {
      comparisons += 1;
      if (candidate === key) return { value, comparisons };
    }
    return { value: null, comparisons };
  };
}
