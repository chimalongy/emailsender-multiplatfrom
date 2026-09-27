'use client';
import { useState } from 'react';

export default function Login() {
  const [email, setEmail] = useState('me.chimaobi@gmail.com');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      window.location.href = '/';
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form onSubmit={submit} className="card">
        <div className="brandmark">E</div>
        <p className="eyebrow">YOUR EMAIL WORKSPACE</p>
        <h1>Welcome back.</h1>
        <p className="muted">One mailbox. All your sending platforms.</p>
        <label>
          Admin email
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoComplete="username"
          />
        </label>
        <label>
          Admin password
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            placeholder="Enter password"
          />
        </label>
        {error && <p role="alert" className="error">{error}</p>}
        <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in →'}</button>
      </form>
    </main>
  );
}
