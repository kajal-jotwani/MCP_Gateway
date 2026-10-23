import { useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';

import { apiResponse } from './api';
import type { ChatEvent } from './api';

// The gateway accepts at most 50 messages of 20,000 characters; older ones are dropped first.
const MAX_HISTORY = 49;
const MAX_TEXT = 20_000;

interface ToolPart {
  kind: 'tool';
  id: string;
  name: string;
  server: string | null;
  input: unknown;
  result?: { isError: boolean; preview: string };
}

type Part = { kind: 'text'; text: string } | ToolPart;

interface UserMessage {
  role: 'user';
  text: string;
}

interface AssistantMessage {
  role: 'assistant';
  parts: Part[];
  done: boolean;
  error?: string;
}

type Message = UserMessage | AssistantMessage;

function assistantText(message: AssistantMessage): string {
  const text = message.parts
    .flatMap((part) => (part.kind === 'text' ? [part.text] : []))
    .join('\n\n')
    .trim();
  return (text || message.error || '(no answer)').slice(0, MAX_TEXT);
}

/** The assistant message after one streamed event. */
function applyEvent(message: AssistantMessage, event: ChatEvent): AssistantMessage {
  switch (event.type) {
    case 'text': {
      const last = message.parts.at(-1);
      return last?.kind === 'text'
        ? {
            ...message,
            parts: [...message.parts.slice(0, -1), { kind: 'text', text: last.text + event.delta }],
          }
        : { ...message, parts: [...message.parts, { kind: 'text', text: event.delta }] };
    }
    case 'tool_call':
      return {
        ...message,
        parts: [
          ...message.parts,
          { kind: 'tool', id: event.id, name: event.name, server: event.server, input: event.input },
        ],
      };
    case 'tool_result':
      return {
        ...message,
        parts: message.parts.map((part) =>
          part.kind === 'tool' && part.id === event.id
            ? { ...part, result: { isError: event.isError, preview: event.preview } }
            : part,
        ),
      };
    case 'error':
      return { ...message, done: true, error: event.message };
    case 'done':
      return { ...message, done: true };
  }
}

/** Parses the newline-delimited JSON events of a chat response as they arrive. */
async function* chatEvents(response: Response): AsyncGenerator<ChatEvent> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffered += value;
    const lines = buffered.split('\n');
    buffered = lines.pop()!;
    for (const line of lines) if (line) yield JSON.parse(line) as ChatEvent;
  }
}

/**
 * Chat with Claude, which calls the gateway's tools as the signed-in member. The conversation lives in
 * this page and is sent with each message; leaving the page ends it.
 */
export function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [running, setRunning] = useState<AbortController>();

  const updateAnswer = (change: (answer: AssistantMessage) => AssistantMessage) =>
    setMessages((current) => [...current.slice(0, -1), change(current.at(-1) as AssistantMessage)]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const question = draft.trim();
    if (!question || running) return;
    const history = [
      ...messages.map((message) =>
        message.role === 'user'
          ? { role: 'user', text: message.text }
          : { role: 'assistant', text: assistantText(message) },
      ),
      { role: 'user', text: question },
    ].slice(-MAX_HISTORY);
    const controller = new AbortController();
    setRunning(controller);
    setDraft('');
    setMessages((current) => [
      ...current,
      { role: 'user', text: question },
      { role: 'assistant', parts: [], done: false },
    ]);
    try {
      const response = await apiResponse('POST', '/chat', { messages: history }, controller.signal);
      for await (const chatEvent of chatEvents(response))
        updateAnswer((answer) => applyEvent(answer, chatEvent));
      updateAnswer((answer) =>
        answer.done ? answer : { ...answer, done: true, error: 'The answer ended early.' },
      );
    } catch (error) {
      const message = controller.signal.aborted ? 'Stopped.' : (error as Error).message;
      updateAnswer((answer) => ({ ...answer, done: true, error: message }));
    } finally {
      setRunning(undefined);
    }
  };

  const sendOnEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <>
      <p className="muted">
        Claude answers with the tools of every connected server, acting as you. Each tool call is shown below
        and recorded in the audit log under your name.
      </p>
      <div className="chat">
        {messages.map((message, index) =>
          message.role === 'user' ? (
            <div key={index} className="bubble user">
              {message.text}
            </div>
          ) : (
            <AssistantAnswer key={index} message={message} />
          ),
        )}
      </div>
      <form onSubmit={(event) => void send(event)}>
        <label>
          Message
          <textarea
            rows={3}
            maxLength={MAX_TEXT}
            placeholder="Which orders came in today?"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={sendOnEnter}
          />
        </label>
        <div className="row">
          <button type="submit" disabled={!!running || !draft.trim()}>
            Send
          </button>
          {running && (
            <button type="button" onClick={() => running.abort()}>
              Stop
            </button>
          )}
          <button type="button" disabled={!!running || messages.length === 0} onClick={() => setMessages([])}>
            New conversation
          </button>
        </div>
      </form>
    </>
  );
}

function AssistantAnswer({ message }: { message: AssistantMessage }) {
  return (
    <div className="bubble assistant">
      {message.parts.map((part, index) =>
        part.kind === 'text' ? (
          <p key={index} className="assistant-text">
            {part.text}
          </p>
        ) : (
          <ToolCall key={part.id} part={part} />
        ),
      )}
      {!message.done && message.parts.length === 0 && <p className="muted">Working…</p>}
      {message.error && <p className="error">{message.error}</p>}
    </div>
  );
}

function ToolCall({ part }: { part: ToolPart }) {
  const [status, label] = !part.result
    ? ['running', 'Running']
    : part.result.isError
      ? ['failed', 'Failed']
      : ['succeeded', 'Done'];
  return (
    <details className="tool-call">
      <summary>
        <span className={`badge ${status}`}>{label}</span> Called <code>{part.name}</code>
        {part.server && ` on ${part.server}`}
      </summary>
      <div className="muted">Arguments</div>
      <pre>{JSON.stringify(part.input, null, 2)}</pre>
      {part.result && (
        <>
          <div className="muted">Result</div>
          <pre>{part.result.preview}</pre>
        </>
      )}
    </details>
  );
}
