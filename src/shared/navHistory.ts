// Back/forward history of editor locations. Pure, so the rules are unit-tested; the renderer's
// navigation service decides when a move counts and feeds it in.

export interface NavLocation {
  path: string
  line: number
  column: number
}

/** Moves within this many lines of the same file are one place, as in VS Code. */
export const NEAR_LINES = 10

export function isNear(a: NavLocation, b: NavLocation): boolean {
  return a.path === b.path && Math.abs(a.line - b.line) <= NEAR_LINES
}

export function isSamePlace(a: NavLocation, b: NavLocation): boolean {
  return a.path === b.path && a.line === b.line
}

/** One edit, in the coordinates of the text before it; `inserted` counts the new line breaks. */
export interface LineEdit {
  startLine: number
  endLine: number
  inserted: number
}

// Where a line ends up after edits applied in order (Monaco lists them bottom-up, so each
// edit's coordinates are still valid when it is applied). Lines inside replaced text move
// to the end of the replacement at most.
export function shiftLine(line: number, edits: LineEdit[]): number {
  for (const edit of edits) {
    if (line > edit.endLine) line += edit.inserted - (edit.endLine - edit.startLine)
    else if (line > edit.startLine) line = Math.min(line, edit.startLine + edit.inserted)
  }
  return Math.max(1, line)
}

export class NavHistory {
  back: NavLocation[] = []
  forward: NavLocation[] = []

  constructor(private readonly limit = 50) {}

  /** A new place was left: it goes on the back stack and the forward stack is dropped. */
  record(location: NavLocation): void {
    const top = this.back[this.back.length - 1]
    if (top && isNear(top, location)) this.back[this.back.length - 1] = { ...location }
    else {
      this.back.push({ ...location })
      if (this.back.length > this.limit) this.back.shift()
    }
    this.forward.length = 0
  }

  /** Next entry in a direction (-1 back, 1 forward), removed from its stack. */
  take(direction: -1 | 1): NavLocation | null {
    return (direction < 0 ? this.back : this.forward).pop() ?? null
  }

  /** Where you were before moving in `direction`, so the opposite move returns there. */
  leave(direction: -1 | 1, here: NavLocation): void {
    const stack = direction < 0 ? this.forward : this.back
    stack.push({ ...here })
    if (stack.length > this.limit) stack.shift()
  }

  can(direction: -1 | 1): boolean {
    return (direction < 0 ? this.back : this.forward).length > 0
  }

  rename(from: string, to: string): void {
    for (const entry of [...this.back, ...this.forward]) {
      if (entry.path === from) entry.path = to
      else if (entry.path.startsWith(`${from}/`)) entry.path = to + entry.path.slice(from.length)
    }
  }

  shift(path: string, edits: LineEdit[]): void {
    for (const entry of [...this.back, ...this.forward]) if (entry.path === path) entry.line = shiftLine(entry.line, edits)
  }

  clear(): void {
    this.back.length = 0
    this.forward.length = 0
  }
}
