import { Plug, Settings, Settings2, X } from 'lucide-react'
import { useEffect, useState, type FC } from 'react'
import type { AgentProvider } from '@shared/agent'
import { t, useLocale } from '../../../src/renderer/src/lib/i18n'
import { loadAgentSettings, useAgent } from '../../../src/renderer/src/services/agent'
import { notify, reportError } from '../../../src/renderer/src/services/ui'
import { AgentSettingsSection } from '../../../src/renderer/src/workbench/AgentSettings'
import { request } from './installBridge'

interface ConnectionResult {
  ok: boolean
  model: string
  kind: string
  latencyMs: number
  message: string
}

type GatewayOrigin = 'claude' | 'codex' | 'none' | 'unknown'

const LOCAL_GATEWAY_ID = 'local-gateway'

export const AiSettingsDrawer: FC<{ open: boolean; onClose(): void }> = function AiSettingsDrawer({ open, onClose }) {
  useLocale()
  const settings = useAgent().settings
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ConnectionResult | null>(null)
  const [connecting, setConnecting] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    void loadAgentSettings()
  }, [open])

  if (!open) return null

  const test = async () => {
    setTesting(true)
    setResult(null)
    try {
      const next = await request<ConnectionResult>('agent:testConnection', [])
      setResult(next)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setResult({ ok: false, model: '', kind: '', latencyMs: 0, message })
      reportError(error, t('Connection test failed'))
    } finally {
      setTesting(false)
    }
  }

  const connectExternal = async () => {
    setConnecting(true)
    try {
      await request('host:setupExternalMcp')
      notify(t('External AI connection started'), 'success')
    } catch (error) {
      reportError(error, t('Cannot connect external AI'))
    } finally {
      setConnecting(false)
    }
  }

  const local = settings?.providers.find((provider) => provider.id === LOCAL_GATEWAY_ID || provider.keySource === 'local')
  const origin: GatewayOrigin = local?.localSource ?? (local?.hasKey ? 'unknown' : 'none')

  return (
    <div className="overlay overlay--center ai-settings-overlay" onMouseDown={onClose}>
      <div
        className="sheet ai-settings-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t('AI & CodeMap Settings')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="sheet-header">
          <h2>
            <Settings2 size={15} />
            {t('AI & CodeMap Settings')}
          </h2>
          <button type="button" className="icon-button" aria-label={t('Close')} onClick={onClose}>
            <X size={15} />
          </button>
        </header>
        <div className="sheet-body">
          <section className="field-group ai-settings-status">
            <h3>{t('Gateway status')}</h3>
            <GatewayStatus local={local} origin={origin} />
            <div className="ai-settings-actions">
              <button type="button" className="button button--primary" disabled={testing} onClick={() => void test()}>
                {testing ? t('Testing connection…') : t('Test Connection')}
              </button>
              {result ? <ConnectionStatus result={result} /> : null}
            </div>
          </section>

          <AgentSettingsSection />

          <section className="field-group">
            <h3>{t('External AI MCP Bridge')}</h3>
            <span className="field-hint">{t('Cursor, Claude Code, and Codex can highlight nodes and propose map layers live.')}</span>
            <div className="ai-settings-actions">
              <button type="button" className="button button--primary" disabled={connecting} onClick={() => void connectExternal()}>
                <Plug size={13} />
                {t('Connect External AI (MCP)')}
              </button>
              <button type="button" className="button" onClick={() => void request('host:openVsCodeSettings')}>
                <Settings size={13} />
                {t('VS Code Settings')}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function GatewayStatus({ local, origin }: { local: AgentProvider | undefined; origin: GatewayOrigin }) {
  if (!local) return <span className="field-hint">{t('No local gateway provider is configured.')}</span>
  const detected = origin === 'claude' || origin === 'codex'
  const connected = Boolean(local.hasKey) || detected
  const protocol = local.kind === 'openai' ? 'OpenAI' : 'Anthropic'
  const where =
    origin === 'claude'
      ? t('Auto-detected Claude Code (~/.claude/settings.json)')
      : origin === 'codex'
        ? t('Auto-detected Codex (~/.codex/config.toml)')
        : local.hasKey
          ? t('Local gateway is available')
          : t('Local gateway not found')
  const status = local.hasKey ? `${where} · ${protocol}` : where
  return (
    <div className={`ai-gateway${connected ? ' is-ok' : ' is-bad'}`}>
      <span className="ai-gateway-name">{t('Local gateway')}</span>
      <span className="ai-gateway-where">{status}</span>
      {local.baseUrl ? <span className="mono ai-gateway-url">{local.baseUrl}</span> : null}
    </div>
  )
}

function ConnectionStatus({ result }: { result: ConnectionResult }) {
  if (result.ok) {
    const model = result.model ? ` · ${result.model}` : ''
    return (
      <span className="ai-connection is-ok" role="status">
        {t('Connected · {ms}ms', { ms: result.latencyMs })}
        {model}
      </span>
    )
  }
  return (
    <span className="ai-connection is-bad" role="status">
      {result.message || t('Connection test failed')}
    </span>
  )
}
