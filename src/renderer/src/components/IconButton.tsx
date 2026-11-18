import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  children: ReactNode
  active?: boolean
  tone?: 'default' | 'accent' | 'danger'
  size?: 'sm' | 'md'
}

// Every icon-only control goes through here so it always has a tooltip and an accessible name.
export function IconButton({ label, children, active, tone = 'default', size = 'md', className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      data-tooltip={label}
      aria-pressed={active === undefined ? undefined : active}
      className={`icon-button icon-button--${size} icon-button--${tone}${active ? ' is-active' : ''}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
    </button>
  )
}
