'use client';

import { useEffect, useRef, useState } from 'react';

export default function WaitlistForm() {
  const [email, setEmail] = useState('');
  // Honeypot — humans never see it. Deliberately meaningless name so browser
  // address autofill never populates it and silently eats a real signup.
  const [trap, setTrap] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  // Keyboard focus must survive the form unmounting on success.
  useEffect(() => {
    if (done) statusRef.current?.focus();
  }, [done]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (trap) {
      setDone(true);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const response = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), source: 'landing' }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          response.status === 429
            ? 'Too many attempts — try again in a minute.'
            : typeof data.error === 'string'
              ? data.error
              : 'Something went wrong. Try again.',
        );
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <p className="form-status ok" role="status" tabIndex={-1} ref={statusRef}>
        ✓ You&rsquo;re on the list — updates land in your inbox as features ship.
      </p>
    );
  }

  return (
    <>
      <form className="cta-form" onSubmit={submit}>
        <input
          type="text"
          name="sc_trap"
          value={trap}
          onChange={(event) => setTrap(event.target.value)}
          className="hp-field"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          type="email"
          name="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            if (error) setError(null);
          }}
          placeholder="you@company.com"
          required
          aria-label="Email address"
        />
        <button type="submit" className="btn primary" aria-disabled={busy}>
          {busy ? 'Joining…' : 'Get early access'} <span aria-hidden="true">→</span>
        </button>
      </form>
      <p className="form-status" role="status">{error ?? ''}</p>
    </>
  );
}
