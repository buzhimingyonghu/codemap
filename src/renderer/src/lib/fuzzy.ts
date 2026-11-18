// Small subsequence matcher for Quick Open and the command palette.
export interface FuzzyMatch {
  score: number
  positions: number[]
}

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (!query) return { score: 0, positions: [] }
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  const positions: number[] = []
  let score = 0
  let lastIndex = -1
  let ti = 0
  for (let qi = 0; qi < q.length; qi++) {
    const char = q[qi]
    if (char === ' ') continue
    const found = t.indexOf(char, ti)
    if (found < 0) return null
    positions.push(found)
    const previous = target[found - 1]
    if (found === 0 || previous === '/' || previous === '_' || previous === '-' || previous === '.' || previous === ' ') score += 8
    else if (target[found] !== t[found] && previous === previous?.toLowerCase()) score += 6
    if (found === lastIndex + 1) score += 5
    score -= Math.min(found - lastIndex - 1, 6)
    lastIndex = found
    ti = found + 1
  }
  score -= Math.max(0, target.length - query.length) * 0.05
  return { score, positions }
}
