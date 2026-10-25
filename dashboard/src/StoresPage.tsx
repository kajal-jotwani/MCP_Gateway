import { useState } from 'react';
import type { FormEvent } from 'react';

import { api, useAction, useApi } from './api';
import type { Member, Store, StoreStatus } from './api';
import { ErrorText, formatTime } from './ui';

// The provisioner works in passes a few seconds apart, so a faster poll would show nothing new.
const POLL_MS = 3000;

const STATUS_LABELS: Record<StoreStatus, string> = {
  provisioning: 'Provisioning',
  ready: 'Ready',
  failed: 'Failed',
  deleting: 'Deleting',
};

/** Stores provisioned from the dashboard. Members create and delete their own; admins can delete any. */
export function StoresPage({ member }: { member: Member }) {
  const { data, error, reload } = useApi<{ stores: Store[] }>('/stores', POLL_MS);

  return (
    <>
      <p className="muted">
        Each store gets its own namespace, database, storage and address, and its own WooCommerce MCP server,
        which the gateway registers once the store is ready. Its tools are named after the store, such as{' '}
        <code>delhi__list_orders</code>, and every member and client can use them.
      </p>
      <StoreForm onCreated={reload} />
      <ErrorText message={error} />
      {data?.stores.length === 0 && <p className="muted">No stores yet.</p>}
      {data && data.stores.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Store</th>
              <th>Status</th>
              <th>URL</th>
              <th>Owner</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.stores.map((store) => (
              <StoreRow
                key={store.id}
                store={store}
                mayManage={member.role === 'admin' || store.ownerId === member.id}
                onChanged={reload}
              />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function StoreForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const { busy, error, run } = useAction();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await api('POST', '/stores', { name });
      setName('');
      onCreated();
    });
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>Create a store</h2>
      <label>
        Name (letters and digits become its slug, so pick one no other store or server uses)
        <input
          required
          maxLength={60}
          placeholder="Delhi"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <ErrorText message={error} />
      <button type="submit" disabled={busy}>
        Create store
      </button>
    </form>
  );
}

function StoreRow({
  store,
  mayManage,
  onChanged,
}: {
  store: Store;
  mayManage: boolean;
  onChanged: () => void;
}) {
  const { busy, error, run } = useAction();
  const retry = () =>
    void run(async () => {
      await api('POST', `/stores/${store.id}/retry`);
      onChanged();
    });
  const remove = () => {
    if (
      !window.confirm(
        `Delete ${store.name}? Its tools disappear at once, and its database, files and orders are deleted.`,
      )
    )
      return;
    void run(async () => {
      await api('DELETE', `/stores/${store.id}`);
      onChanged();
    });
  };

  return (
    <tr>
      <td>
        {store.name} <code className="muted">{store.slug}</code>
      </td>
      <td>
        <span className={`badge ${store.status}`}>{STATUS_LABELS[store.status]}</span>
        {store.reason && <div className="error">{store.reason}</div>}
      </td>
      <td>
        {store.status === 'ready' ? (
          <a href={store.url} target="_blank" rel="noreferrer">
            {store.url}
          </a>
        ) : (
          <span className="muted">{store.url}</span>
        )}
      </td>
      <td>{store.ownerName}</td>
      <td>{formatTime(store.createdAt)}</td>
      <td>
        {mayManage && store.status !== 'deleting' && (
          <div className="row">
            {store.status === 'failed' && (
              <button type="button" disabled={busy} onClick={retry}>
                Retry
              </button>
            )}
            <button type="button" className="danger" disabled={busy} onClick={remove}>
              Delete
            </button>
          </div>
        )}
        <ErrorText message={error} />
      </td>
    </tr>
  );
}
