import React, { useEffect, useState } from 'react';
import { api, useApi } from '../lib/api';
import { Banner, Card, Chip, ConfirmButton, Empty, Field, Modal, Stat } from '../components/ui';
import { formatDate } from '../lib/format';

type Credential = { id: number; service: string; label: string; fields: string[]; created_at: string };

type OAuthProvider = {
  id: string;
  label: string;
  note?: string;
  scopes: string[];
  configured: boolean;
  redirectUri: string;
  clientIdLabel: string;
  clientIdHint?: string;
  clientSecretHint?: string;
};

export function SettingsPage({ user }: { user: { email: string; name: string } }) {
  const settings = useApi<Record<string, any>>('/settings');
  const credentials = useApi<{ items: Credential[] }>('/settings/credentials');
  const serpProviders = useApi<{ items: any[]; active: string }>('/seo-providers');
  const oauthProviders = useApi<{ items: OAuthProvider[] }>('/oauth/providers');

  const [form, setForm] = useState<Record<string, any>>({});
  const [saved, setSaved] = useState(false);
  const [addingSerp, setAddingSerp] = useState(false);

  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);

  const save = async (changes: Record<string, unknown>) => {
    await api.patch('/settings', changes);
    setForm((prev) => ({ ...prev, ...changes }));
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
    void settings.reload();
    void serpProviders.reload();
  };

  return (
    <>
      <header className="topbar">
        <h1>Settings</h1>
        <span className="spacer" />
        {saved && <Chip tone="good">Saved</Chip>}
      </header>

      <div className="page stack" style={{ gap: 14 }}>
        <div className="grid cols-2">
          <Card title="Account">
            <div className="stack">
              <Stat label="Signed in as" value={user.name || user.email} sub={user.email} small />
              <p className="small muted">
                Helm is single-user by design — there is no sign-up, no sharing and no second account.
              </p>
            </div>
          </Card>

          <Card title="Business details">
            <div className="stack">
              <Field label="Business name">
                <input
                  value={form.businessName ?? ''}
                  onChange={(e) => setForm({ ...form, businessName: e.target.value })}
                  onBlur={(e) => save({ businessName: e.target.value })}
                />
              </Field>
              <div className="field-row">
                <Field label="Currency">
                  <input
                    value={form.currency ?? 'USD'}
                    onChange={(e) => setForm({ ...form, currency: e.target.value })}
                    onBlur={(e) => save({ currency: e.target.value.toUpperCase() })}
                  />
                </Field>
                <Field label="Invoice prefix">
                  <input
                    value={form.invoicePrefix ?? 'INV-'}
                    onChange={(e) => setForm({ ...form, invoicePrefix: e.target.value })}
                    onBlur={(e) => save({ invoicePrefix: e.target.value })}
                  />
                </Field>
              </div>
            </div>
          </Card>
        </div>

        <SocialApps
          providers={oauthProviders.data?.items ?? []}
          publicUrl={form.publicUrl ?? ''}
          onPublicUrlChange={(v) => setForm({ ...form, publicUrl: v })}
          onPublicUrlSave={(v) => save({ publicUrl: v })}
          onChanged={() => {
            void oauthProviders.reload();
            void credentials.reload();
          }}
        />

        <Card title="Rank tracking">
          <div className="stack">
            <Field
              label="SERP provider"
              hint="Manual entry costs nothing. An API provider lets Helm check positions and build competitive briefs on its own."
            >
              <select
                value={serpProviders.data?.active ?? 'manual'}
                onChange={(e) => save({ seoSerpProvider: e.target.value })}
              >
                {(serpProviders.data?.items ?? []).map((p: any) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </Field>

            {serpProviders.data?.active !== 'manual' && (
              <>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={!!form.seoAutoRankCheck}
                    onChange={(e) => save({ seoAutoRankCheck: e.target.checked })}
                  />
                  Refresh rankings automatically each day
                </label>
                <Field label="Daily rank-check limit" hint="Caps how many paid API calls Helm makes per day.">
                  <input
                    type="number"
                    min={1}
                    max={200}
                    value={form.seoDailyRankLimit ?? 10}
                    onChange={(e) => setForm({ ...form, seoDailyRankLimit: Number(e.target.value) })}
                    onBlur={(e) => save({ seoDailyRankLimit: Number(e.target.value) })}
                    style={{ width: 120 }}
                  />
                </Field>
                <button className="btn" onClick={() => setAddingSerp(true)}>Set API key</button>
              </>
            )}
          </div>
        </Card>

        <Card
          title="Stored credentials"
          actions={<span className="small muted">Encrypted with AES-256-GCM</span>}
          padded={false}
        >
          {(credentials.data?.items ?? []).length ? (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Service</th><th>Label</th><th>Fields</th><th>Added</th><th></th></tr></thead>
                <tbody>
                  {credentials.data!.items.map((cred) => (
                    <tr key={cred.id}>
                      <td>{cred.service}</td>
                      <td className="muted">{cred.label || '—'}</td>
                      <td>
                        <span className="row wrap">
                          {cred.fields.map((f) => <Chip key={f}>{f}</Chip>)}
                        </span>
                      </td>
                      <td className="small muted">{formatDate(cred.created_at)}</td>
                      <td className="right">
                        <ConfirmButton
                          onConfirm={async () => {
                            await api.del(`/settings/credentials/${cred.id}`);
                            void credentials.reload();
                          }}
                        >
                          Delete
                        </ConfirmButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon="🔒" title="No credentials stored" hint="Connect a social account or a SERP provider to add one." />
          )}
        </Card>

        <Card title="How your data is stored">
          <ul className="small dim" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Everything lives in a single SQLite file on your machine — nothing is sent anywhere except the APIs you connect.</li>
            <li>Third-party tokens are encrypted at rest with a key derived from <code>HELM_SECRET</code>, and the API never returns them.</li>
            <li>Back up by copying the database file; restore by putting it back.</li>
          </ul>
        </Card>
      </div>

      {addingSerp && (
        <SerpKeyForm
          provider={serpProviders.data?.active ?? 'serpapi'}
          onClose={() => setAddingSerp(false)}
          onSaved={() => {
            setAddingSerp(false);
            void credentials.reload();
          }}
        />
      )}
    </>
  );
}

/**
 * Registration details for the networks that use a browser OAuth flow. The
 * client id and secret come from each network's developer portal; Helm stores
 * them encrypted and never returns them.
 */
function SocialApps({
  providers,
  publicUrl,
  onPublicUrlChange,
  onPublicUrlSave,
  onChanged,
}: {
  providers: OAuthProvider[];
  publicUrl: string;
  onPublicUrlChange: (value: string) => void;
  onPublicUrlSave: (value: string) => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<OAuthProvider | null>(null);

  return (
    <Card
      title="Connected apps"
      actions={
        <span className="small muted">Google Search Console, LinkedIn, Facebook, Instagram, TikTok</span>
      }
    >
      <div className="stack">
        <Field
          label="Public URL"
          hint="Where Helm is reachable. Must match the redirect URI you register with each network."
        >
          <input
            value={publicUrl}
            placeholder="http://localhost:4000"
            onChange={(e) => onPublicUrlChange(e.target.value)}
            onBlur={(e) => onPublicUrlSave(e.target.value)}
          />
        </Field>

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Network</th><th>App</th><th>Redirect URI to register</th><th></th></tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.label}
                    {p.note && <div className="small muted" style={{ maxWidth: 320 }}>{p.note}</div>}
                  </td>
                  <td>
                    {p.configured ? <Chip tone="good">configured</Chip> : <Chip tone="warning">not set</Chip>}
                  </td>
                  <td>
                    <code className="small" style={{ wordBreak: 'break-all' }}>{p.redirectUri}</code>
                  </td>
                  <td className="right">
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button className="btn sm" onClick={() => setEditing(p)}>
                        {p.configured ? 'Edit keys' : 'Add keys'}
                      </button>
                      {p.configured && (
                        <a className="btn sm primary" href={`/api/oauth/${p.id}/start`}>
                          Connect
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          Google Search Console powers the SEO module — it reports the queries your site actually
          ranks for. X uses keys you issue yourself, so it is added on the Social → Accounts tab
          rather than here.
        </p>
      </div>

      {editing && (
        <AppKeyForm provider={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />
      )}
    </Card>
  );
}

function AppKeyForm({
  provider,
  onClose,
  onSaved,
}: {
  provider: OAuthProvider;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState('');

  return (
    <Modal
      title={`${provider.label} app keys`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!clientId.trim() || !clientSecret.trim()}
            onClick={async () => {
              try {
                await api.post(`/oauth/app/${provider.id}`, {
                  client_id: clientId.trim(),
                  client_secret: clientSecret.trim(),
                });
                onSaved();
              } catch (err: any) {
                setError(err?.message ?? 'Could not save');
              }
            }}
          >
            Save
          </button>
        </>
      }
    >
      <Banner tone="error">{error}</Banner>

      {provider.id === 'google' && (
        <div className="banner" style={{ lineHeight: 1.55 }}>
          <strong>Where these come from</strong>
          <ol style={{ margin: '6px 0 0 18px', padding: 0 }}>
            <li>
              <a href="https://console.cloud.google.com/apis/library/searchconsole.googleapis.com" target="_blank" rel="noreferrer noopener">
                Enable the Search Console API
              </a>
            </li>
            <li>
              <a href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noreferrer noopener">
                Google Auth Platform → Audience
              </a>{' '}
              → under <strong>Test users</strong>, add your own Google address
            </li>
            <li>
              <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noreferrer noopener">
                Google Auth Platform → Clients
              </a>{' '}
              → <strong>Create client</strong> → type <strong>Web application</strong> → add the
              redirect URI below
            </li>
          </ol>
          <div className="small muted" style={{ marginTop: 6 }}>
            On older consoles those last two live under APIs &amp; Services → OAuth consent screen
            and → Credentials. Check the project picker at the top matches the project where you
            enabled the API.
          </div>
        </div>
      )}

      <p className="small muted">
        Register this redirect URI in the {provider.label} developer portal, exactly as shown:
      </p>
      <code className="small" style={{ wordBreak: 'break-all' }}>{provider.redirectUri}</code>
      <p className="small muted">Scopes requested: {provider.scopes.join(', ')}</p>
      <Field label={provider.clientIdLabel} hint={provider.clientIdHint}>
        <input
          autoFocus
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder={provider.id === 'google' ? '…apps.googleusercontent.com' : ''}
        />
      </Field>
      <Field label="client_secret" hint={provider.clientSecretHint}>
        <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
      </Field>
    </Modal>
  );
}

function SerpKeyForm({ provider, onClose, onSaved }: { provider: string; onClose: () => void; onSaved: () => void }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState('');

  return (
    <Modal
      title={`${provider} API key`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!key.trim()}
            onClick={async () => {
              try {
                await api.post('/settings/credentials', {
                  service: 'serp',
                  label: provider,
                  data: { api_key: key.trim() },
                });
                onSaved();
              } catch (err: any) {
                setError(err?.message ?? 'Could not save');
              }
            }}
          >
            Save key
          </button>
        </>
      }
    >
      <Banner tone="error">{error}</Banner>
      <Field label="API key" hint="Stored encrypted; never returned by the API.">
        <input type="password" autoFocus value={key} onChange={(e) => setKey(e.target.value)} />
      </Field>
    </Modal>
  );
}
