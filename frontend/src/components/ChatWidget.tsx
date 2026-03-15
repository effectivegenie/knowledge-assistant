import { useRef, useEffect, useState, useCallback, KeyboardEvent } from 'react';
import { Avatar, Button, Input, Typography } from 'antd';
import { SendOutlined, UserOutlined, DeleteOutlined } from '@ant-design/icons';
import { useWebSocket } from '../hooks/useWebSocket';

const { Text, Title } = Typography;
const { TextArea } = Input;

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
              }}
            >
              {msg.role === 'assistant' && (
                <Avatar
                  size="small"
                  src="/genie-logo-final-2-no-text.png"
                  alt="Knowledge Genie"
                  style={{
                    backgroundColor: '#f5f5f5',
                    flexShrink: 0,
                    marginTop: 4,
                  }}
                />
              )}
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
