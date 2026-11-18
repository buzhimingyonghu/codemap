import { describe, expect, it } from 'vitest'
import { NavHistory, shiftLine } from '../../src/shared/navHistory'

const at = (path: string, line: number) => ({ path, line, column: 1 })

describe('navigation history', () => {
  it('goes back and forward through recorded places', () => {
    const h = new NavHistory()
    h.record(at('a', 1))
    h.record(at('b', 50))
    // Now at c:5. Back returns to b:50, remembering c:5 for forward.
    const back = h.take(-1)!
    h.leave(-1, at('c', 5))
    expect(back).toEqual(at('b', 50))
    expect(h.can(1)).toBe(true)
    const forward = h.take(1)!
    h.leave(1, back)
    expect(forward).toEqual(at('c', 5))
    expect(h.back.map((e) => e.path)).toEqual(['a', 'b'])
  })

  it('merges nearby places and drops forward history on a new move', () => {
    const h = new NavHistory()
    h.record(at('a', 10))
    h.record(at('a', 18))
    expect(h.back).toEqual([at('a', 18)])
    h.record(at('a', 40))
    h.take(-1)
    h.leave(-1, at('a', 90))
    h.record(at('b', 1))
    expect(h.can(1)).toBe(false)
  })

  it('caps its size and follows renames', () => {
    const h = new NavHistory(3)
    for (let i = 0; i < 5; i++) h.record(at(`/p/f${i}`, 1))
    expect(h.back.map((e) => e.path)).toEqual(['/p/f2', '/p/f3', '/p/f4'])
    h.rename('/p', '/q')
    expect(h.back[0].path).toBe('/q/f2')
  })

  it('shifts lines when text above them changes', () => {
    // Two lines inserted at line 3 move line 10 to 12; line 2 stays.
    expect(shiftLine(10, [{ startLine: 3, endLine: 3, inserted: 2 }])).toBe(12)
    expect(shiftLine(2, [{ startLine: 3, endLine: 3, inserted: 2 }])).toBe(2)
    // Deleting a range from line 5 to line 8 removes three line breaks: line 20 moves to 17,
    // and line 6, inside the range, moves to where it started.
    expect(shiftLine(20, [{ startLine: 5, endLine: 8, inserted: 0 }])).toBe(17)
    expect(shiftLine(6, [{ startLine: 5, endLine: 8, inserted: 0 }])).toBe(5)
    const h = new NavHistory()
    h.record(at('a', 30))
    h.shift('a', [{ startLine: 1, endLine: 1, inserted: 1 }])
    expect(h.back[0].line).toBe(31)
  })
})
