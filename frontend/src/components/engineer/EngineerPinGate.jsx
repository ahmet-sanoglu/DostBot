import React, { useState } from 'react';
import { getStoredAdminPin, storeAdminPin, verifyAdminPin } from '../../utils/adminApi';

export default function EngineerPinGate({ onAuthenticated }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError('');

    try {
      await verifyAdminPin(pin);
      storeAdminPin(pin);
      onAuthenticated(pin);
    } catch (err) {
      setError(err.message || 'Geçersiz PIN');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="engineer-pin-gate">
      <form className="engineer-pin-gate__card" onSubmit={handleSubmit}>
        <h2>Mühendis Paneli</h2>
        <p className="engineer-pin-gate__hint">Devam etmek için PIN girin.</p>
        <label className="engineer-form__field engineer-form__field--full">
          <span>PIN</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="••••"
            required
          />
        </label>
        {error && (
          <p className="engineer-form__error">{error}</p>
        )}
        <button type="submit" className="autonomous-btn" disabled={loading}>
          {loading ? 'Doğrulanıyor…' : 'Giriş'}
        </button>
      </form>
    </div>
  );
}

export function useEngineerAuth() {
  const [authenticated, setAuthenticated] = useState(() => Boolean(getStoredAdminPin()));

  return {
    authenticated,
    setAuthenticated,
  };
}
