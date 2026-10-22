import { useState } from 'react';
import type { Me } from '@party/shared';
import { api } from './api';
import { PinInput, primary } from './Join';

export function PinSettings({ me, onChange }: { me: Me; onChange: (me: Me) => void }) {
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');

  async function save(value: string | null) {
    setError('');
    try {
      onChange(await api.setPin(value));
      setOpen(false);
      setPin('');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!open) {
    return (
      <button className="self-center text-zinc-400" onClick={() => setOpen(true)}>
        {me.hasPin ? '🔒 Change or remove my PIN' : '🔓 Add a PIN to protect my account'}
      </button>
    );
  }
  return (
    <section className="flex flex-col gap-3 rounded-2xl bg-zinc-800 p-4">
      <p className="text-zinc-300">{me.hasPin ? 'Choose a new 4-digit PIN' : 'Choose a 4-digit PIN'}</p>
      <PinInput value={pin} onChange={setPin} autoFocus />
      {error && <p className="text-red-300">{error}</p>}
      <button className={primary} disabled={!/^\d{4}$/.test(pin)} onClick={() => save(pin)}>
        Save PIN
      </button>
      {me.hasPin && (
        <button className="text-red-300" onClick={() => save(null)}>
          Remove my PIN
        </button>
      )}
      <button className="text-zinc-400" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </section>
  );
}
