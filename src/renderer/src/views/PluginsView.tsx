import { CircleAlert, FolderOpen, RefreshCw } from 'lucide-react'
import { IconButton } from '../components/IconButton'
import { t } from '../lib/i18n'
import { loadPlugins, setPluginEnabled } from '../plugins/host'
import { notify, reportError } from '../services/ui'
import { useStore } from '../state/store'

export function PluginsView() {
  const plugins = useStore((s) => s.plugins)
  const appInfo = useStore((s) => s.appInfo)

  const reload = async () => {
    await loadPlugins()
    notify(t('Plugins reloaded'), 'success')
  }

  return (
    <div className="plugins-view">
      <div className="view-header">
        <span className="view-title">{t('Plugins')}</span>
        <div className="view-actions">
          <IconButton size="sm" label={t('Open Plugins Folder')} onClick={() => void window.codemap.plugins.openFolder().catch(reportError)}>
            <FolderOpen size={14} />
          </IconButton>
          <IconButton size="sm" label={t('Reload Plugins')} onClick={() => void reload()}>
            <RefreshCw size={14} />
          </IconButton>
        </div>
      </div>
      <div className="plugin-list">
        {plugins.length === 0 ? <div className="section-empty">{t('No plugins installed')}</div> : null}
        {plugins.map(({ descriptor, active, error }) => {
          const { manifest } = descriptor
          return (
            <article key={`${descriptor.source}:${manifest.id}`} className={`plugin-card${error ? ' has-error' : ''}`}>
              <div className="plugin-head">
                <span className={`plugin-state${active ? ' is-active' : ''}`} aria-hidden="true" />
                <div className="plugin-title">
                  <span className="plugin-name">{manifest.name}</span>
                  <span className="plugin-meta">
                    {manifest.id} · v{manifest.version} · {descriptor.source}
                  </span>
                </div>
                <label className="switch" data-tooltip={descriptor.enabled ? t('Disable') : t('Enable')}>
                  <input
                    type="checkbox"
                    checked={descriptor.enabled}
                    disabled={Boolean(descriptor.error)}
                    aria-label={t('Enable {name}', { name: manifest.name })}
                    onChange={(event) => void setPluginEnabled(manifest.id, event.target.checked).catch(reportError)}
                  />
                  <span className="switch-track" />
                </label>
              </div>
              {manifest.description ? <p className="plugin-description">{manifest.description}</p> : null}
              {manifest.permissions?.network?.length ? (
                <p className="plugin-permissions">{t('Network: {list}', { list: manifest.permissions.network.join(', ') })}</p>
              ) : null}
              {error ? (
                <p className="plugin-error">
                  <CircleAlert size={13} />
                  <span>{error}</span>
                </p>
              ) : null}
            </article>
          )
        })}
      </div>
      {appInfo ? (
        <div className="plugin-footer" title={appInfo.userPluginsDir}>
          {appInfo.userPluginsDir.replace(/^\/Users\/[^/]+/, '~')}
        </div>
      ) : null}
    </div>
  )
}
