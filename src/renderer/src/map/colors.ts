// Map palettes. The dark one is the holographic survey look; the light one keeps the same
// structure readable on the Paper theme.

export interface MapColors {
  dark: boolean
  bg: string
  bgCenter: string
  bgEdge: string
  /** "r,g,b" of the survey grid. */
  grid: string
  gridAlpha: number
  tick: string
  coastFill: string
  coastGlow: string
  coastAlpha: number
  /** Color of the world itself (the root folder). */
  accent: string
  ink: string
  bright: string
  shade: string
  neutral: string
  modified: string
  palette: string[]
  vignette: string
  grainAlpha: number
  focusGlow: number
}

const DARK: MapColors = {
  dark: true,
  bg: '#06080b',
  bgCenter: '#0d1318',
  bgEdge: '#05070a',
  grid: '150,190,210',
  gridAlpha: 0.045,
  tick: 'rgba(160,200,220,0.16)',
  coastFill: '#0a1014',
  coastGlow: 'rgba(80,200,220,0.25)',
  coastAlpha: 0.28,
  accent: '#8fd6e0',
  ink: '#d9e6ee',
  bright: '#f2fbff',
  shade: '#05070a',
  neutral: '#9fb3c8',
  modified: '#ffb547',
  palette: ['#ff8a6b', '#a5e86a', '#c49bff', '#46d9e6', '#6fa4ff', '#ff8fcb', '#77f0c0', '#ffc04a'],
  vignette: 'rgba(0,0,0,0.55)',
  grainAlpha: 10,
  focusGlow: 0.55
}

const LIGHT: MapColors = {
  dark: false,
  bg: '#eef1ef',
  bgCenter: '#f8faf9',
  bgEdge: '#e2e7e5',
  grid: '30,60,70',
  gridAlpha: 0.07,
  tick: 'rgba(30,60,70,0.22)',
  coastFill: '#fbfcfc',
  coastGlow: 'rgba(15,118,110,0.22)',
  coastAlpha: 0.4,
  accent: '#0f766e',
  ink: '#1f2a30',
  bright: '#0b1418',
  shade: '#ffffff',
  neutral: '#5d7183',
  modified: '#c2410c',
  palette: ['#d9542f', '#4d8f1f', '#7c4dd6', '#0e8f9c', '#2f66d0', '#c23f8a', '#14936a', '#b7791f'],
  vignette: 'rgba(40,60,70,0.10)',
  grainAlpha: 7,
  focusGlow: 0.3
}

export function mapColors(appearance: 'dark' | 'light'): MapColors {
  return appearance === 'light' ? LIGHT : DARK
}
