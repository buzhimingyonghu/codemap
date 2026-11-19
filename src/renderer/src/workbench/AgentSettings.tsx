import { KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AGENT_MODES, type AgentMode, type AgentProvider, type AgentSettings } from '@shared/agent'
import { t } from '../lib/i18n'
import { loadAgentSettings, selectProvider } from '../services/agent'
import { notify, reportError } from '../services/ui'

// Settings → AI: which model service the assistant uses and the default model per mode.
// Keys are stored encrypted in the keychain and never shown again.

const MODE_LABEL = (): Record<AgentMode, string> => ({ ask: t('Ask'), adjust: t('Adjust map'), create: t('Build map'), require: t('Requirement') })

function localProviderTitle(provider: AgentProvider): string {
  if (provider.localSource === 'claude' || provider.id === 'local-gateway') return t('Claude Code Gateway')
  if (provider.localSource === 'codex' || provider.id === 'local-codex') return t('Codex / Magpie Gateway')
  return t('Local gateway')
}

function newProvider(): AgentProvider {
  return { id: 'custom-' + Math.random().toString(36).slice(2, 7), name: t('Custom provider'), kind: 'openai', baseUrl: 'https://', keySource: 'stored', model: '' }
}

export function AgentSettingsSection() {
  const [s, setS] = useState<AgentSettings | null>(null)
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [models, setModels] = useState<Record<string, string[]>>({})
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void window.codemap.agent.settings().then(setS, () => setS(null))
  }, [])
  const activeId = s?.activeProvider ?? ''
  const activeHasKey = s?.providers.find((provider) => provider.id === activeId)?.hasKey
  useEffect(() => {
    if (!activeId || activeHasKey === false) return
    let cancelled = false
    void window.codemap.agent.models(activeId).then(
      (list) => {
        if (cancelled) return
        setModels((current) => (current[activeId] ? current : { ...current, [activeId]: list }))
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [activeId, activeHasKey])
  if (!s) return null

  const patch = (id: string, change: Partial<AgentProvider>) => setS({ ...s, providers: s.providers.map((p) => (p.id === id ? { ...p, ...change } : p)) })
  const save = async (next = s) => {
    setBusy(true)
    try {
      let saved = await window.codemap.agent.saveSettings(next)
      for (const [id, key] of Object.entries(keys)) if (key) saved = await window.codemap.agent.setKey(id, key)
      setKeys({})
      setS(saved)
      await loadAgentSettings()
      if (saved.activeProvider) await selectProvider(saved.activeProvider, { keepModel: true })
      notify(t('AI settings saved'), 'success')
    } catch (error) {
      reportError(error, t('Cannot save AI settings'))
    } finally {
      setBusy(false)
    }
  }
  const fetchModels = async (id: string) => {
    try {
      const list = await window.codemap.agent.models(id)
      setModels({ ...models, [id]: list })
      notify(t('{n} models', { n: list.length }), 'info')
    } catch (error) {
      reportError(error, t('Cannot list models'))
    }
  }
  const active = s.providers.find((p) => p.id === s.activeProvider)
  const activeModels = active ? (models[active.id] ?? []) : []

  return (
    <section className="field-group">
      <h3>{t('AI Assistant')}</h3>
      <span className="field-hint">{t('The assistant in the code map (AI tab) uses this model service. Local gateway reuses the gateway already set up for Claude Code or Codex on this Mac.')}</span>

      {s.providers.map((p) => {
        const isActive = p.id === s.activeProvider
        const tt = p.keySource === 'local'
        return (
          <div key={p.id} className={'ai-provider' + (isActive ? ' is-active' : '')}>
            <div className="ai-provider-head">
              <input type="radio" name="ai-active" checked={isActive} aria-label={t('Use this provider')} onChange={() => setS({ ...s, activeProvider: p.id })} />
              {tt ? <span className="ai-provider-name">{localProviderTitle(p)}</span> : <input className="input ai-provider-name" value={p.name} onChange={(e) => patch(p.id, { name: e.target.value })} />}
              <span className={'ai-provider-state ' + (p.hasKey ? 'is-ok' : 'is-bad')}>
                {tt ? (p.hasKey ? t('Connected') : t('Local gateway not found')) : p.hasKey ? t('Key saved') : t('No key')}
              </span>
              {!tt ? (
                <button type="button" className="icon-button icon-button--sm" aria-label={t('Remove')} onClick={() => setS({ ...s, providers: s.providers.filter((x) => x.id !== p.id), activeProvider: isActive ? 'local-gateway' : s.activeProvider })}>
                  <Trash2 size={13} />
                </button>
              ) : null}
            </div>
            <div className="ai-grid">
              {!tt ? (
                <>
                  <span>{t('API type')}</span>
                  <div className="segmented" role="radiogroup">
                    {(['openai', 'anthropic'] as const).map((k) => (
                      <button key={k} type="button" role="radio" aria-checked={p.kind === k} className={p.kind === k ? 'is-on' : undefined} onClick={() => patch(p.id, { kind: k })}>
                        {k === 'openai' ? 'OpenAI ' + t('compatible') : 'Anthropic'}
                      </button>
                    ))}
                  </div>
                  <span>{t('Base URL')}</span>
                  <input className="input mono" value={p.baseUrl} spellCheck={false} placeholder={p.kind === 'openai' ? 'https://host/v1' : 'https://host'} onChange={(e) => patch(p.id, { baseUrl: e.target.value })} />
                  <span>{t('API key')}</span>
                  <div className="input-row">
                    <input className="input mono" type="password" value={keys[p.id] ?? ''} placeholder={p.hasKey ? t('Saved; type to replace') : 'sk-…'} onChange={(e) => setKeys({ ...keys, [p.id]: e.target.value })} />
                    {p.hasKey ? (
                      <button type="button" className="icon-button" aria-label={t('Remove key')} data-tooltip={t('Remove key')} onClick={() => void window.codemap.agent.setKey(p.id, null).then(setS)}>
                        <KeyRound size={14} />
                      </button>
                    ) : null}
                  </div>
                </>
              ) : (
                <>
                  <span>{t('Address')}</span>
                  <span className="ai-provider-endpoint">
                    <span className="mono">{p.baseUrl}</span>
                    <span className="ai-kind">{p.kind === 'openai' ? 'OpenAI' : 'Anthropic'}</span>
                  </span>
                </>
              )}
              <span>{t('Default model')}</span>
              <div className="input-row">
                <input className="input mono" list={'ai-models-' + p.id} value={p.model} spellCheck={false} onChange={(e) => patch(p.id, { model: e.target.value })} />
                <datalist id={'ai-models-' + p.id}>
                  {(models[p.id] ?? []).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <button type="button" className="icon-button" aria-label={t('Load model list')} data-tooltip={t('Load model list (save the key first)')} onClick={() => void fetchModels(p.id)}>
                  <RefreshCw size={14} />
                </button>
              </div>
            </div>
          </div>
        )
      })}
      <button type="button" className="button" onClick={() => setS({ ...s, providers: [...s.providers, newProvider()] })}>
        <Plus size={13} />
        {t('Add provider')}
      </button>

      <div className="field">
        <span className="field-label">{t('Model per mode (empty: the default model)')}</span>
        <div className="ai-grid">
          {AGENT_MODES.map((m) => (
            <div key={m} style={{ display: 'contents' }}>
              <span>{MODE_LABEL()[m]}</span>
              <input className="input mono" list="ai-mode-models" value={s.modeModels[m] ?? ''} spellCheck={false} placeholder={active?.model} onChange={(e) => setS({ ...s, modeModels: { ...s.modeModels, [m]: e.target.value } })} />
            </div>
          ))}
          <datalist id="ai-mode-models">
            {activeModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
      </div>

      <div className="field">
        <div className="ai-grid">
          <span>{t('Parallel sub-agents')}</span>
          <input className="input mono" type="number" min={1} max={8} value={s.maxParallel} onChange={(e) => setS({ ...s, maxParallel: Number(e.target.value) })} />
        </div>
      </div>

      <div className="ai-save">
        <button type="button" className="button button--primary" disabled={busy} onClick={() => void save()}>
          {t('Save AI settings')}
        </button>
      </div>
    </section>
  )
}
