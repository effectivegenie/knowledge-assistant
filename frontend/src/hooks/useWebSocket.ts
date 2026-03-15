import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../auth/AuthContext';
import { config } from '../config';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
}

interface WebSocketMessage {
  type: 'chunk' | 'end' | 'error' | 'history';
  content?: string;
  message?: string;
  messages?: { role: string; text: string; timestamp: string }[];
}

export function useWebSocket() {
  const { idToken, user } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const reconnectDelayRef = useRef(1000);

  const userEmail = user?.email ?? '';
  const tenantId = user?.tenantId ?? 'default';

  useEffect(() => {
    if (!idToken) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setIsConnected(false);
      setHistoryLoaded(false);
      return;
    }

    function connect() {
      const ws = new WebSocket(
        `${config.websocket.url}?token=${idToken}`,
      );
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        reconnectDelayRef.current = 1000;

        if (userEmail) {
          ws.send(JSON.stringify({ action: 'history', user: userEmail, tenantId }));
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        wsRef.current = null;

        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, reconnectDelayRef.current);

        reconnectDelayRef.current = Math.min(
          reconnectDelayRef.current * 2,
          30000,
        );
      };

      ws.onmessage = (event) => {
        const data: WebSocketMessage = JSON.parse(event.data);

        if (data.type === 'history') {
          if (data.messages && data.messages.length > 0) {
            const restored: ChatMessage[] = data.messages.map((m) => ({
              id: crypto.randomUUID(),
              role: m.role === 'ai' ? 'assistant' : (m.role as 'user' | 'assistant'),
              content: m.text,
            }));
            setMessages(restored);
          }
          setHistoryLoaded(true);
        } else if (data.type === 'chunk') {
          setMessages((prev) => {
            const updated = [...prev];
            for (let i = updated.length - 1; i >= 0; i--) {
              if (updated[i].role === 'assistant' && updated[i].isStreaming) {
                updated[i] = {
                  ...updated[i],
                  content: updated[i].content + (data.content ?? ''),
                };
                break;
              }
            }
            return updated;
          });
        } else if (data.type === 'end') {
          setMessages((prev) => {
            const updated = [...prev];
            for (let i = updated.length - 1; i >= 0; i--) {
              if (updated[i].role === 'assistant' && updated[i].isStreaming) {
                updated[i] = { ...updated[i], isStreaming: false };
                break;
              }
            }
            return updated;
          });
        } else if (data.type === 'error') {
          setMessages((prev) => {
            const updated = [...prev];
            for (let i = updated.length - 1; i >= 0; i--) {
              if (updated[i].role === 'assistant' && updated[i].isStreaming) {
                updated[i] = {
                  ...updated[i],
                  content:
                    updated[i].content +
                    `\n\nError: ${data.message ?? 'Something went wrong.'}`,
                  isStreaming: false,
                };
                break;
              }
            }
            return updated;
          });
        }
      };
    }

    connect();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [idToken, userEmail, tenantId]);

  const sendMessage = useCallback(
    (prompt: string) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: prompt,
      };

      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        isStreaming: true,
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);

      wsRef.current.send(
        JSON.stringify({ action: 'sendMessage', user: userEmail, tenantId, text: prompt }),
      );
    },
    [userEmail, tenantId],
  );

  const clearMessages = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && userEmail) {
      wsRef.current.send(
        JSON.stringify({ action: 'clear_history', user: userEmail, tenantId }),
      );
    }
    setMessages([]);
  }, [userEmail, tenantId]);

  return { messages, isConnected, sendMessage, clearMessages, historyLoaded };
}
