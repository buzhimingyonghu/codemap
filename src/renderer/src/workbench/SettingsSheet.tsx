import { Check, FolderSearch, Minus, Plus, RotateCw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { WorkspaceSettings } from '@shared/types'
import { IconButton } from '../components/IconButton'
import { THEMES, applyTheme, getTheme } from '../editor/themes'
import { DEFAULT_ITEMS_PER_SCREEN, ITEMS_PER_SCREEN_RANGE } from '../map/engine'
import { LOCALES } from '@shared/i18n'
import { setLocale, t, useLocale } from '../lib/i18n'
import { onDidChangeTheme } from '../plugins/host'
import { refreshServers, restartServer } from '../services/lsp'
import { notify, reportError } from '../services/ui'
import { saveSettings } from '../services/workspace'
import { setState, useStore } from '../state/store'
import { AgentSettingsSection } from './AgentSettings'

// Splits an argument string the way a shell would for simple quoting.
function splitArgs(input: string): string[] {
  const args: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(input))) args.push(match[1] ?? match[2] ?? match[3])
  return args
}

function joinArgs(args: string[]): string {
  return args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ')
}

export function setTheme(id: string): void {
  applyTheme(id)
  setState({ theme: id })
  void window.codemap.app.setTheme(id)
  const theme = getTheme(id)
  onDidChangeTheme.emit({ id: theme.id, appearance: theme.appearance })
}

// Applies immediately, like the theme: an open map reframes its current level right away.
function MapDensity() {
  const value = useStore((s) => s.mapItemsPerScreen)
  const [lo, hi] = ITEMS_PER_SCREEN_RANGE
  const set = (next: number) => setState({ mapItemsPerScreen: Math.max(lo, Math.min(hi, Math.round(next))) })
  // Finer steps at the low end, where each item changes the view the most.
  const down = value > 100 ? 20 : value > 40 ? 10 : 5
  const up = value >= 100 ? 20 : value >= 40 ? 10 : 5
  return (
    <section className="field-group">
      <h3>{t('Map')}</h3>
      <div className="field">
        <span className="field-label" id="map-density-label">
          {t('Items per screen when entering a folder')}
        </span>
        <div className="range-row">
          <input
            type="range"
            className="range"
            min={lo}
            max={hi}
            step={5}
            value={value}
            aria-labelledby="map-density-label"
            onChange={(event) => set(Number(event.target.value))}
          />
          <div className="stepper" role="group" aria-label={t('Items per screen')}>
            <IconButton size="sm" label={t('Fewer')} disabled={value <= lo} onClick={() => set(value - down)}>
              <Minus size={13} />
            </IconButton>
            <input
              className="input mono stepper-value"
              inputMode="numeric"
              value={value}
              aria-labelledby="map-density-label"
              onChange={(event) => {
                const n = Number(event.target.value.replace(/\D/g, ''))
                if (n) set(n)
              }}
            />
            <IconButton size="sm" label={t('More')} disabled={value >= hi} onClick={() => set(value + up)}>
              <Plus size={13} />
            </IconButton>
          </div>
          <IconButton size="sm" label={t('Reset to {n}', { n: DEFAULT_ITEMS_PER_SCREEN })} disabled={value === DEFAULT_ITEMS_PER_SCREEN} onClick={() => set(DEFAULT_ITEMS_PER_SCREEN)}>
            <RotateCw size={13} />
          </IconButton>
        </div>
        <span className="field-hint">{t('Every level opens at this density; folders with fewer items open whole. Zoom out to see the rest.')}</span>
      </div>
    </section>
  )
}

// Folders outside the open folder that the code map may read. Revoking applies immediately.
function CodeMapAccess() {
  const [grants, setGrants] = useState<string[] | null>(null)
  useEffect(() => {
    void window.codemap.codemap.grants().then(setGrants)
  }, [])
  if (!grants) return null
  return (
    <section className="field-group">
      <h3>{t('Code Map')}</h3>
      <div className="field">
        <span className="field-label">{t('Folders outside the open folder the code map may read')}</span>
        {grants.length ? (
          <div className="server-list">
            {grants.map((folder) => (
              <div key={folder} className="server-row">
                <div className="server-main">
                  <span className="server-name mono">{folder}</span>
                </div>
                <IconButton size="sm" label={t('Revoke')} onClick={() => void window.codemap.codemap.revoke(folder).then(setGrants)}>
                  <X size={13} />
                </IconButton>
              </div>
            ))}
          </div>
        ) : (
          <span className="field-hint">{t('None yet. The code map asks before reading a folder outside the open folder.')}</span>
        )}
      </div>
    </section>
  )
}

export function SettingsSheet() {
  const open = useStore((s) => s.settingsOpen)
  const locale = useLocale()
  const workspace = useStore((s) => s.workspace)
  const settings = useStore((s) => s.settings)
  const theme = useStore((s) => s.theme)
  const servers = useStore((s) => s.lspServers)
  const [draft, setDraft] = useState<WorkspaceSettings | null>(settings)
  const [args, setArgs] = useState('')

  useEffect(() => {
    if (!open) return
    setDraft(settings)
    setArgs(joinArgs(settings?.debug.args ?? []))
    void refreshServers()
  }, [open, settings])

  if (!open) return null
  const close = () => setState({ settingsOpen: false })
  const relative = (path: string) => (workspace && path.startsWith(`${workspace.root}/`) ? path.slice(workspace.root.length + 1) : path)

  const pickProgram = async () => {
    const file = await window.codemap.workspace.pickFile()
    if (file && draft) setDraft({ ...draft, debug: { ...draft.debug, program: relative(file) } })
  }

  const save = async () => {
    if (!draft) return
    try {
      await saveSettings({ ...draft, debug: { ...draft.debug, args: splitArgs(args) } })
      notify(t('Settings saved'), 'success')
      close()
    } catch (error) {
      reportError(error, t('Cannot save settings'))
    }
  }

  return (
    <div className="overlay overlay--center" onMouseDown={close}>
      <div
        className="sheet"
        role="dialog"
        aria-label={t('Settings')}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close()
          if (event.key === 'Enter' && event.metaKey) void save()
        }}
      >
        <header className="sheet-header">
          <h2>{t('Settings')}</h2>
          <IconButton label={t('Close')} onClick={close}>
            <X size={15} />
          </IconButton>
        </header>

        <div className="sheet-body">
          <section className="field-group">
            <h3>{t('Appearance')}</h3>
            <div className="theme-picker" role="radiogroup" aria-label={t('Theme')}>
              {THEMES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={theme === option.id}
                  className={`theme-option${theme === option.id ? ' is-selected' : ''}`}
                  onClick={() => setTheme(option.id)}
                >
                  <span className="theme-swatch" style={{ background: option.swatch[0] }}>
                    <span style={{ background: option.swatch[1] }} />
                    <span style={{ background: option.swatch[2] }} />
                  </span>
                  <span className="theme-label">{option.label}</span>
                  {theme === option.id ? <Check size={13} className="theme-check" /> : null}
                </button>
              ))}
            </div>
            <div className="field">
              <span className="field-label" id="language-label">
                {t('Language')}
              </span>
              <div className="segmented" role="radiogroup" aria-labelledby="language-label">
                {LOCALES.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={locale === option.id}
                    className={locale === option.id ? 'is-on' : undefined}
                    onClick={() => setLocale(option.id)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <MapDensity />
          <CodeMapAccess />
          <AgentSettingsSection />

          {workspace && draft ? (
            <>
              <section className="field-group">
                <h3>{t('Build')}</h3>
                <label className="field">
                  <span className="field-label">{t('Build command')}</span>
                  <input
                    className="input mono"
                    value={draft.buildCommand}
                    placeholder="make, swift build, cargo build, clang -g main.c -o app"
                    spellCheck={false}
                    onChange={(event) => setDraft({ ...draft, buildCommand: event.target.value })}
                    autoFocus
                  />
                  <span className="field-hint">{t('Runs in {name} with your login shell.', { name: workspace.name })}</span>
                </label>
              </section>

              <section className="field-group">
                <h3>{t('Debug')}</h3>
                <label className="field">
                  <span className="field-label">{t('Program')}</span>
                  <div className="input-row">
                    <input
                      className="input mono"
                      value={draft.debug.program}
                      placeholder="build/app"
                      spellCheck={false}
                      onChange={(event) => setDraft({ ...draft, debug: { ...draft.debug, program: event.target.value } })}
                    />
                    <IconButton label={t('Choose Program')} onClick={() => void pickProgram()}>
                      <FolderSearch size={15} />
                    </IconButton>
                  </div>
                </label>
                <label className="field">
                  <span className="field-label">{t('Arguments')}</span>
                  <input className="input mono" value={args} placeholder="--verbose input.txt" spellCheck={false} onChange={(event) => setArgs(event.target.value)} />
                </label>
                <label className="field">
                  <span className="field-label">{t('Working directory')}</span>
                  <input
                    className="input mono"
                    value={relative(draft.debug.cwd) === workspace.root ? '' : relative(draft.debug.cwd)}
                    placeholder={t('Folder root')}
                    spellCheck={false}
                    onChange={(event) => setDraft({ ...draft, debug: { ...draft.debug, cwd: event.target.value || workspace.root } })}
                  />
                </label>
                <div className="toggles">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={draft.debug.preLaunchBuild}
                      onChange={(event) => setDraft({ ...draft, debug: { ...draft.debug, preLaunchBuild: event.target.checked } })}
                    />
                    <span>{t('Build before debugging')}</span>
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={draft.debug.stopOnEntry}
                      onChange={(event) => setDraft({ ...draft, debug: { ...draft.debug, stopOnEntry: event.target.checked } })}
                    />
                    <span>{t('Stop at entry')}</span>
                  </label>
                </div>
              </section>

              <section className="field-group">
                <h3>{t('Language Servers')}</h3>
                <div className="server-list">
                  {servers.map((server) => (
                    <div key={server.id} className={`server-row state-${server.state}`}>
                      <span className="server-dot" aria-hidden="true" />
                      <div className="server-main">
                        <span className="server-name">{server.label}</span>
                        <span className="server-meta">
                          {server.binary ?? t('Not installed')}
                          {server.compileDatabase ? ` · ${server.compileDatabase === 'generated' ? '.codemap/compile_commands.json (auto)' : server.compileDatabase}` : ''}
                        </span>
                        {server.projectRoots?.length ? (
                          <span className="server-meta" title={server.projectRoots.join('\n')}>
                            {server.projectRoots.map((root) => (root === workspace.root ? '.' : root.slice(workspace.root.length + 1) || root)).join(', ')}
                          </span>
                        ) : null}
                      </div>
                      <span className="server-state">{server.state}</span>
                      {server.binary ? (
                        <IconButton size="sm" label={t('Restart {name}', { name: server.label })} onClick={() => void restartServer(server.id)}>
                          <RotateCw size={13} />
                        </IconButton>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
            </>
          ) : null}
        </div>

        <footer className="sheet-footer">
          <button type="button" className="button" onClick={close}>
            {t('Cancel')}
          </button>
          {workspace ? (
            <button type="button" className="button button--primary" onClick={() => void save()}>
              {t('Save')}
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  )
}
