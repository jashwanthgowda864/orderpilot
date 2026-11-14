import { useState } from 'react';
import { useAuth } from '../auth.jsx';
import { ErrorBox, useAction } from '../components/ui.jsx';

export default function Login() {
  const { login } = useAuth();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAction();
  return (
    <div className="login">
      <form className="card" onSubmit={(e) => { e.preventDefault(); run(() => login(phone.trim(), password)); }}>
        <h1>OrderPilot</h1>
        <p className="muted">Sign in with your phone number.</p>
        <label>Phone<input inputMode="tel" autoComplete="username" value={phone} onChange={(e) => setPhone(e.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        <ErrorBox error={error} />
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
