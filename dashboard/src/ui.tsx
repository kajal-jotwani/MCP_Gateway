import { useRef, useState } from 'react';

export function ErrorText({ message }: { message?: string }) {
  return message ? (
    <p className="error" role="alert">
      {message}
    </p>
  ) : null;
}

/**
 * A read-only value with a Copy button. Over plain HTTP the browser has no clipboard API, so the
 * button selects the text and asks for the keyboard shortcut instead.
 */
export function CopyField({ value, label }: { value: string; label: string }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [hint, setHint] = useState<string>();

  const copy = async () => {
    input.current?.select();
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(value);
      setHint('Copied.');
    } else {
      setHint('Press Ctrl+C or Cmd+C to copy the selected text.');
    }
  };

  return (
    <div className="copy-field">
      <textarea
        ref={input}
        aria-label={label}
        readOnly
        rows={Math.max(1, value.split('\n').length)}
        value={value}
        onFocus={(event) => event.currentTarget.select()}
      />
      <div className="row">
        <button type="button" onClick={() => void copy()}>
          Copy
        </button>
        {hint && <span className="muted">{hint}</span>}
      </div>
    </div>
  );
}

export function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'never';
}
