import { useState } from 'react';
import { post } from '../api.js';
import { ErrorBox, useAction } from './ui.jsx';

const LANG_NAME = { en: 'English', kn: 'Kannada', hi: 'Hindi' };

export function useReminderDraft() {
  const [draft, setDraft] = useState(null);
  const [copied, setCopied] = useState(false);
  const act = useAction();

  const request = (customer) => act.run(async () => {
    setCopied(false);
    const res = await post('/reminders/draft', { customer_id: customer.id });
    setDraft({ ...res, customer_name: customer.name });
  });

  const copy = async () => {
    if (!draft?.text) return;
    try {
      await navigator.clipboard.writeText(draft.text);
      setCopied(true);
    } catch {
      // Fallback for non-HTTPS/restricted clipboard
      setCopied(false);
    }
  };

  return { draft, copied, busy: act.busy, error: act.error, request, copy, clear: () => setDraft(null) };
}

export function ReminderDraftBox({ state }) {
  if (!state.draft && !state.error) return null;
  return (
    <section className="card attention">
      {state.error && <ErrorBox error={state.error} />}
      {state.draft && (
        <>
          <div className="row spread">
            <strong>
              Payment reminder for {state.draft.customer_name}
              <span className="tag tag-prev">{LANG_NAME[state.draft.language] || state.draft.language}</span>
              <span className="tag tag-prev">{state.draft.source === 'ai' ? 'AI' : 'template'}</span>
            </strong>
            <button type="button" className="link small" onClick={state.clear}>Close</button>
          </div>
          <textarea rows={3} readOnly value={state.draft.text} aria-label="Payment reminder draft" />
          <div className="row">
            <button type="button" onClick={state.copy}>{state.copied ? 'Copied' : 'Copy'}</button>
            <span className="muted small">Review and send manually — nothing is sent automatically.</span>
          </div>
        </>
      )}
    </section>
  );
}
