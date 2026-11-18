import { useEffect, useRef, useState } from 'react'

interface TooltipState {
  text: string
  x: number
  y: number
  placement: 'top' | 'bottom' | 'right'
}

// One global tooltip driven by `data-tooltip`, so components only declare text.
export function TooltipLayer() {
  const [tip, setTip] = useState<TooltipState | null>(null)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    const show = (target: HTMLElement) => {
      const text = target.dataset.tooltip
      if (!text) return
      const rect = target.getBoundingClientRect()
      const preferred = (target.dataset.tooltipPlacement as TooltipState['placement']) ?? 'bottom'
      let placement = preferred
      if (placement === 'bottom' && rect.bottom + 34 > window.innerHeight) placement = 'top'
      const x = placement === 'right' ? rect.right + 8 : rect.left + rect.width / 2
      const y = placement === 'right' ? rect.top + rect.height / 2 : placement === 'top' ? rect.top - 6 : rect.bottom + 6
      setTip({ text, x, y, placement })
    }
    const onOver = (event: MouseEvent) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-tooltip]')
      if (timer.current) window.clearTimeout(timer.current)
      if (!target) {
        setTip(null)
        return
      }
      timer.current = window.setTimeout(() => show(target), 450)
    }
    const hide = () => {
      if (timer.current) window.clearTimeout(timer.current)
      setTip(null)
    }
    document.addEventListener('mouseover', onOver)
    document.addEventListener('mousedown', hide, true)
    document.addEventListener('keydown', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mousedown', hide, true)
      document.removeEventListener('keydown', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])

  if (!tip) return null
  return (
    <div className={`tooltip tooltip--${tip.placement}`} style={{ left: tip.x, top: tip.y }} role="tooltip">
      {tip.text}
    </div>
  )
}
