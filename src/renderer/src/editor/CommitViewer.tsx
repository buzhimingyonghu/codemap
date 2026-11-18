import { useEffect, useState } from 'react'

export function CommitViewer({ hash }: { hash: string }) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setError(null)
    window.codemap.git
      .show(hash)
      .then((text) => !cancelled && setContent(text))
      .catch((reason: Error) => !cancelled && setError(reason.message))
    return () => {
      cancelled = true
    }
  }, [hash])

  if (error) return <div className="panel-empty">{error}</div>
  if (content === null) return <div className="panel-empty">Loading commit…</div>
  return (
    <pre className="commit-view">
      {content.split('\n').map((line, index) => {
        let kind = ''
        if (line.startsWith('+++') || line.startsWith('---')) kind = 'meta'
        else if (line.startsWith('+')) kind = 'add'
        else if (line.startsWith('-')) kind = 'del'
        else if (line.startsWith('@@')) kind = 'hunk'
        else if (line.startsWith('diff --git') || line.startsWith('commit ')) kind = 'head'
        return (
          <span key={index} className={`diff-line ${kind}`}>
            {line || ' '}
            {'\n'}
          </span>
        )
      })}
    </pre>
  )
}
