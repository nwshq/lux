'use client';

import { useChat } from '@ai-sdk/react';
import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit, isLoading, error } =
    useChat();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>Lux Concierge</h1>
        <p style={styles.subtitle}>
          Ask questions backed by organizational knowledge
        </p>
      </header>

      <main style={styles.messages}>
        {messages.length === 0 && (
          <div style={styles.empty}>
            <p style={styles.emptyText}>
              Ask me anything about your organization. I&apos;ll search the
              knowledge base and consult domain experts to find answers.
            </p>
          </div>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            style={{
              ...styles.message,
              ...(message.role === 'user' ? styles.userMessage : styles.assistantMessage),
            }}
          >
            <div style={styles.messageRole}>
              {message.role === 'user' ? 'You' : 'Lux'}
            </div>
            <div style={styles.messageContent}>
              {message.parts.map((part, i) => {
                if (part.type === 'text') {
                  return message.role === 'user' ? (
                    <span key={i}>{part.text}</span>
                  ) : (
                    <div key={i} className="prose">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {part.text}
                      </ReactMarkdown>
                    </div>
                  );
                }
                if (part.type === 'tool-invocation') {
                  return (
                    <div key={i} style={styles.toolCall}>
                      <span style={styles.toolIcon}>&#9881;</span>
                      {part.toolInvocation.toolName === 'lux_search'
                        ? `Searching: "${part.toolInvocation.args?.query}"`
                        : `Asking expert: "${part.toolInvocation.args?.question?.slice(0, 80)}..."`}
                    </div>
                  );
                }
                return null;
              })}
            </div>
          </div>
        ))}

        {isLoading && (
          <div style={styles.loading}>Thinking...</div>
        )}

        {error && (
          <div style={styles.error}>
            Error: {error.message}
          </div>
        )}

        <div ref={messagesEndRef} />
      </main>

      <form onSubmit={handleSubmit} style={styles.form}>
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="Ask a question..."
          style={styles.input}
          disabled={isLoading}
        />
        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          style={{
            ...styles.button,
            opacity: isLoading || !input.trim() ? 0.5 : 1,
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    maxWidth: 800,
    margin: '0 auto',
  },
  header: {
    padding: '24px 16px 12px',
    borderBottom: '1px solid #262626',
  },
  title: {
    margin: 0,
    fontSize: 20,
    fontWeight: 600,
    color: '#f5f5f5',
  },
  subtitle: {
    margin: '4px 0 0',
    fontSize: 13,
    color: '#737373',
  },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  empty: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
  },
  emptyText: {
    color: '#525252',
    fontSize: 14,
    textAlign: 'center',
    maxWidth: 400,
    lineHeight: 1.6,
  },
  message: {
    padding: '12px 16px',
    borderRadius: 8,
    maxWidth: '85%',
  },
  userMessage: {
    alignSelf: 'flex-end',
    backgroundColor: '#1a365d',
  },
  assistantMessage: {
    alignSelf: 'flex-start',
    backgroundColor: '#1c1c1c',
    border: '1px solid #262626',
  },
  messageRole: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    color: '#737373',
    marginBottom: 4,
    letterSpacing: '0.05em',
  },
  messageContent: {
    fontSize: 14,
    lineHeight: 1.6,
  },
  toolCall: {
    fontSize: 12,
    color: '#a3a3a3',
    backgroundColor: '#0a0a0a',
    padding: '6px 10px',
    borderRadius: 4,
    marginTop: 4,
    fontFamily: 'monospace',
  },
  toolIcon: {
    marginRight: 6,
  },
  loading: {
    alignSelf: 'flex-start',
    padding: '8px 16px',
    fontSize: 13,
    color: '#737373',
    fontStyle: 'italic',
  },
  error: {
    alignSelf: 'center',
    padding: '8px 16px',
    fontSize: 13,
    color: '#ef4444',
    backgroundColor: '#1c1c1c',
    border: '1px solid #7f1d1d',
    borderRadius: 6,
  },
  form: {
    display: 'flex',
    gap: 8,
    padding: 16,
    borderTop: '1px solid #262626',
  },
  input: {
    flex: 1,
    padding: '10px 14px',
    fontSize: 14,
    borderRadius: 6,
    border: '1px solid #333',
    backgroundColor: '#141414',
    color: '#e5e5e5',
    outline: 'none',
  },
  button: {
    padding: '10px 20px',
    fontSize: 14,
    fontWeight: 500,
    borderRadius: 6,
    border: 'none',
    backgroundColor: '#2563eb',
    color: 'white',
    cursor: 'pointer',
  },
};
