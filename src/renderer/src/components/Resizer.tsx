import { useCallback } from 'react'

interface ResizerProps {
  direction: 'horizontal' | 'vertical'
  onResize: (delta: number) => void
  onReset?: () => void
  label: string
}

export function Resizer({ direction, onResize, onReset, label }: ResizerProps) {
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const element = event.currentTarget
      element.setPointerCapture(event.pointerId)
      let last = direction === 'horizontal' ? event.clientX : event.clientY
      document.body.classList.add(direction === 'horizontal' ? 'is-resizing-x' : 'is-resizing-y')
      const move = (moveEvent: PointerEvent) => {
        const current = direction === 'horizontal' ? moveEvent.clientX : moveEvent.clientY
        onResize(current - last)
        last = current
      }
      const up = () => {
        element.removeEventListener('pointermove', move)
        element.removeEventListener('pointerup', up)
        element.removeEventListener('pointercancel', up)
        document.body.classList.remove('is-resizing-x', 'is-resizing-y')
      }
      element.addEventListener('pointermove', move)
      element.addEventListener('pointerup', up)
      element.addEventListener('pointercancel', up)
    },
    [direction, onResize]
  )

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
      className={`resizer resizer--${direction}`}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
    />
  )
}
