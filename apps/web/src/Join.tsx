import { useState, type FormEvent } from 'react';
import { NAME_MAX, type Me } from '@party/shared';
import { api } from './api';

const AVATARS = ['🦊', '🐸', '🐼', '🦄', '🐙', '🔥', '👾', '🍕'];

export const field = 'w-full rounded-2xl bg-zinc-800 p-4 text-xl outline-none focus:ring-2 focus:ring-emerald-500';
export const primary = 'w-full rounded-2xl bg-emerald-600 p-4 text-xl font-bold disabled:opacity-50 active:bg-emerald-700';

type Step = 'phone' | 'name' | 'pin';

export function Join({ onDone }: { onDone: (me: Me, welcomeBack: boolean) => void }) {
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState(AVATARS[0]!);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const pinOk = /^\d{4}$/.test(pin);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api.join({
        phone,
        ...(step === 'name' ? { name, avatar, ...(pin ? { pin } : {}) } : {}),
        ...(step === 'pin' ? { pin } : {}),
      });
      if (res.status === 'needName') setStep('name');
      else if (res.status === 'needPin') setStep('pin');
      else onDone(res.me, res.status === 'welcomeBack');
    } catch (err) {
      setError((err as Error).message);
      if (step === 'pin') setPin('');
    } finally {
      setBusy(false);
    }
  }

  const back = () => {
    setStep('phone');
    setPin('');
    setError('');
  };

  const disabled =
    busy || !phone.trim() || (step === 'name' && (!name.trim() || (pin !== '' && !pinOk))) || (step === 'pin' && !pinOk);

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-6 p-6">
      <h1 className="text-center text-5xl font-extrabold tracking-tight">Party Night</h1>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-2">
          <span className="text-zinc-400">Your phone number</span>
          <input
            className={field}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="07700 900123"
            value={phone}
            disabled={step !== 'phone'}
            onChange={(e) => setPhone(e.target.value)}
            required
          />
        </label>

        {step === 'name' && (
          <>
            <p className="text-zinc-300">New here! Pick a name everyone will see.</p>
            <input
              className={field}
              placeholder="Display name"
              maxLength={NAME_MAX}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
            />
            <div className="flex flex-wrap justify-center gap-2">
              {AVATARS.map((a) => (
                <button
                  type="button"
                  key={a}
                  onClick={() => setAvatar(a)}
                  className={`h-14 w-14 rounded-2xl text-3xl ${a === avatar ? 'bg-emerald-600' : 'bg-zinc-800'}`}
                >
                  {a}
                </button>
              ))}
            </div>
            <label className="flex flex-col gap-2">
              <span className="text-zinc-400">Optional 4-digit PIN (stops friends signing in as you)</span>
              <PinInput value={pin} onChange={setPin} />
            </label>
          </>
        )}

        {step === 'pin' && (
          <label className="flex flex-col gap-2">
            <span className="text-zinc-300">Enter your 4-digit PIN</span>
            <PinInput value={pin} onChange={setPin} autoFocus />
          </label>
        )}

        {error && <p className="text-center text-red-300">{error}</p>}
        <button className={primary} disabled={disabled}>
          {busy ? '...' : step === 'name' ? "Let's go" : step === 'pin' ? 'Unlock' : 'Continue'}
        </button>
        {step !== 'phone' && (
          <button type="button" className="text-zinc-400" onClick={back}>
            Wrong number?
          </button>
        )}
      </form>
      <p className="text-center text-sm text-zinc-500">Your number stays on the host's laptop. Nobody else sees it.</p>
    </main>
  );
}

export function PinInput({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <input
      className={`${field} text-center tracking-[0.6em]`}
      type="password"
      inputMode="numeric"
      autoComplete="off"
      maxLength={4}
      placeholder="••••"
      value={value}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 4))}
    />
  );
}
