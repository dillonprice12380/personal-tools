import { Router } from 'express';
import { all, get, getSetting, run, setSetting } from '../db.js';
import { decryptJson, encryptJson } from '../lib/crypto.js';
import { notFound, requireFields, toInt, wrap } from '../lib/http.js';

export const settingsRouter = Router();

const DEFAULTS = {
  currency: 'USD',
  timezone: 'UTC',
  businessName: '',
  invoicePrefix: 'INV-',
  weekStart: 1,
};

settingsRouter.get(
  '/',
  wrap((_req, res) => {
    const rows = all<{ key: string; value_json: string }>('SELECT key, value_json FROM settings');
    const values: Record<string, unknown> = { ...DEFAULTS };
    for (const row of rows) {
      try {
        values[row.key] = JSON.parse(row.value_json);
      } catch {
        /* ignore malformed setting */
      }
    }
    res.json(values);
  })
);

settingsRouter.patch(
  '/',
  wrap((req, res) => {
    for (const [key, value] of Object.entries(req.body ?? {})) setSetting(key, value);
    res.json(Object.fromEntries(Object.keys(req.body ?? {}).map((k) => [k, getSetting(k, null)])));
  })
);

/**
 * Credentials are write-only over the API: the plaintext never comes back out,
 * only the field names so the UI can show what is configured.
 */
settingsRouter.get(
  '/credentials',
  wrap((_req, res) => {
    const rows = all<{ id: number; service: string; label: string; data_enc: string; created_at: string }>(
      'SELECT id, service, label, data_enc, created_at FROM credentials ORDER BY service, id'
    );
    res.json({
      items: rows.map((row) => {
        let fields: string[] = [];
        try {
          fields = Object.keys(decryptJson<Record<string, unknown>>(row.data_enc));
        } catch {
          fields = ['<undecryptable - HELM_SECRET changed?>'];
        }
        return {
          id: row.id,
          service: row.service,
          label: row.label,
          created_at: row.created_at,
          fields,
        };
      }),
    });
  })
);

settingsRouter.post(
  '/credentials',
  wrap((req, res) => {
    requireFields(req.body ?? {}, ['service', 'data']);
    const { service, label, data } = req.body;
    const info = run('INSERT INTO credentials (service, label, data_enc) VALUES (?, ?, ?)', [
      service,
      label ?? '',
      encryptJson(data),
    ]);
    res.status(201).json({ id: Number(info.lastInsertRowid), service, label: label ?? '' });
  })
);

settingsRouter.delete(
  '/credentials/:id',
  wrap((req, res) => {
    const id = toInt(req.params.id);
    const row = get('SELECT id FROM credentials WHERE id = ?', [id]);
    if (!row) throw notFound('Credential');
    run('DELETE FROM credentials WHERE id = ?', [id]);
    res.status(204).end();
  })
);
