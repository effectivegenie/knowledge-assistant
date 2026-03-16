import { useRef, useEffect, useState, useCallback, KeyboardEvent } from 'react';
import { Avatar, Button, Input, Typography, Collapse, Badge } from 'antd';
import { SendOutlined, UserOutlined, DeleteOutlined, FileTextOutlined } from '@ant-design/icons';
import { useWebSocket } from '../hooks/useWebSocket';
import type { Citation } from '../hooks/useWebSocket';

const { Text, Title } = Typography;
const { TextArea } = Input;

function getFilename(s3Uri: string): string {
  return s3Uri.split('/').pop() || s3Uri;
}

function CitationsPanel({ citations }: { citations: Citation[] }) {
  if (!citations || citations.length === 0) return null;

  const items = [
    {
      key: 'sources',
      label: (
        <span style={{ fontSize: 12, color: '#666' }}>
          <FileTextOutlined style={{ marginRight: 6 }} />
          Sources ({citations.length})
        </span>
      ),
      children: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {citations.map((c, i) => (
            <div
              key={i}
              style={{
                background: '#f9fafb',
                borderRadius: 6,
                padding: '8px 10px',
                border: '1px solid #e8e8e8',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <Text strong style={{ fontSize: 12 }}>{getFilename(c.source)}</Text>
                <Badge
                  count={`${Math.round(c.score * 100)}%`}
                  style={{ backgroundColor: '#1e3a5f', fontSize: 10 }}
                />
              </div>
              {c.excerpt && (
                <Text type="secondary" style={{ fontSize: 11, lineHeight: 1.4 }}>
                  {c.excerpt}
                </Text>
              )}
            </div>
          ))}
        </div>
      ),
    },
  ];

  return (
    <Collapse
      size="small"
      items={items}
      style={{ marginTop: 6, border: 'none', background: 'transparent' }}
      styles={{ header: { padding: '4px 0', background: 'transparent' } }}
    />
  );
}

export default function ChatWidget() {
  const { messages, isConnected, sendMessage, clearMessages } = useWebSocket();
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const isStreamingActive =
    messages.length > 0 &&
    messages[messages.length - 1].role === 'assistant' &&
    messages[messages.length - 1].isStreaming;

  const canSend = isConnected && input.trim().length > 0 && !isStreamingActive;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || !canSend) return;
    sendMessage(trimmed);
    setInput('');
  }, [input, canSend, sendMessage]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        maxWidth: 900,
        margin: '0 auto',
        width: '100%',
      }}
    >
      <div
        ref={messagesContainerRef}
        className="chat-messages"
        style={{ flex: 1, padding: '24px 16px', overflowY: 'auto' }}
      >
        {messages.length === 0 ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: '100%',
              gap: 16,
            }}
          >
            <img
              src="/genie-logo-final-2-no-text.png"
              alt="Knowledge Genie"
              style={{ width: 72, height: 72, objectFit: 'contain', opacity: 0.9 }}
            />
            <Title
              level={4}
              style={{ margin: 0, color: 'rgba(0, 0, 0, 0.45)' }}
            >
              Ask me anything about the knowledge base
            </Title>
            <Text type="secondary">
              Type your question below to get started
            </Text>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              style={{
                display: 'flex',
                justifyContent:
                  msg.role === 'user' ? 'flex-end' : 'flex-start',
                alignItems: 'flex-start',
                gap: 8,
                marginBottom: 4,
              }}
            >
              {msg.role === 'assistant' && (
                <Avatar
                  size={60}
                  src="/genie-logo-final-2-no-text.png"
                  alt="Knowledge Genie"
                  style={{
                    backgroundColor: '#f5f5f5',
                    flexShrink: 0,
                    marginTop: 4,
                  }}
                />
              )}
              <div style={{ maxWidth: msg.role === 'assistant' ? '75%' : undefined }}>
                <div
                  className={`message-bubble ${
                    msg.role === 'user' ? 'message-user' : 'message-assistant'
                  }`}
                >
                  {msg.role === 'assistant' &&
                  msg.isStreaming &&
                  msg.content === '' ? (
                    <div className="typing-indicator">
                      <span />
                      <span />
                      <span />
                    </div>
                  ) : (
                    <>
                      {msg.content}
                      {msg.role === 'assistant' && msg.isStreaming && (
                        <span className="blinking-cursor" />
                      )}
                    </>
                  )}
                </div>
                {msg.role === 'assistant' && msg.citations && msg.citations.length > 0 && (
                  <CitationsPanel citations={msg.citations} />
                )}
              </div>
              {msg.role === 'user' && (
                <Avatar
                  size="small"
                  icon={<UserOutlined />}
                  style={{
                    backgroundColor: '#1677ff',
                    flexShrink: 0,
                    marginTop: 4,
                  }}
                />
              )}
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      <div
        style={{
          padding: '12px 16px',
          borderTop: '1px solid #f0f0f0',
          background: '#fff',
          display: 'flex',
          gap: 12,
          alignItems: 'flex-end',
        }}
      >
        {messages.length > 0 && (
          <Button
            icon={<DeleteOutlined />}
            onClick={clearMessages}
            title="Clear chat"
          />
        )}
        <TextArea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your message..."
          autoSize={{ minRows: 1, maxRows: 4 }}
          style={{ flex: 1 }}
          disabled={!isConnected}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          size="large"
          onClick={handleSend}
          disabled={!canSend}
        />
      </div>
    </div>
  );
}
