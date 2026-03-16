import { describe, it, expect, vi } from 'vitest';

// Test the pure message-state reducer logic extracted from useWebSocket
// Rather than rendering the hook (which requires WebSocket + auth), we test
// the state transitions that happen in the onmessage handler.

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
}

// Inline the state transitions from useWebSocket for unit testing
function applyChunk(messages: ChatMessage[], content: string): ChatMessage[] {
  const updated = [...messages];
  for (let i = updated.length - 1; i >= 0; i--) {
    if (updated[i].role === 'assistant' && updated[i].isStreaming) {
      updated[i] = { ...updated[i], content: updated[i].content + content };
      break;
    }
  }
  return updated;
}

function applyEnd(messages: ChatMessage[]): ChatMessage[] {
  const updated = [...messages];
  for (let i = updated.length - 1; i >= 0; i--) {
    if (updated[i].role === 'assistant' && updated[i].isStreaming) {
      updated[i] = { ...updated[i], isStreaming: false };
      break;
    }
  }
  return updated;
}

function applyError(messages: ChatMessage[], errorMessage: string): ChatMessage[] {
  const updated = [...messages];
  for (let i = updated.length - 1; i >= 0; i--) {
    if (updated[i].role === 'assistant' && updated[i].isStreaming) {
      updated[i] = {
        ...updated[i],
        content: updated[i].content + `\n\nError: ${errorMessage}`,
        isStreaming: false,
      };
      break;
    }
  }
  return updated;
}

describe('useWebSocket message state transitions', () => {
  const baseMessages: ChatMessage[] = [
    { id: '1', role: 'user', content: 'Hello' },
    { id: '2', role: 'assistant', content: '', isStreaming: true },
  ];

  describe('chunk', () => {
    it('appends content to the last streaming assistant message', () => {
      const result = applyChunk(baseMessages, 'Hi');
      expect(result[1].content).toBe('Hi');
    });

    it('accumulates multiple chunks', () => {
      let msgs = applyChunk(baseMessages, 'Hello');
      msgs = applyChunk(msgs, ' world');
      expect(msgs[1].content).toBe('Hello world');
    });

    it('does not modify user messages', () => {
      const result = applyChunk(baseMessages, 'test');
      expect(result[0].content).toBe('Hello');
      expect(result[0].role).toBe('user');
    });

    it('only updates the last streaming assistant message', () => {
      const msgs: ChatMessage[] = [
        { id: '1', role: 'user', content: 'Q1' },
        { id: '2', role: 'assistant', content: 'A1', isStreaming: false },
        { id: '3', role: 'user', content: 'Q2' },
        { id: '4', role: 'assistant', content: '', isStreaming: true },
      ];
      const result = applyChunk(msgs, 'A2');
      expect(result[1].content).toBe('A1');
      expect(result[3].content).toBe('A2');
    });
  });

  describe('end', () => {
    it('sets isStreaming to false on the last streaming assistant message', () => {
      const result = applyEnd(baseMessages);
      expect(result[1].isStreaming).toBe(false);
    });

    it('preserves accumulated content', () => {
      const msgs = applyChunk(baseMessages, 'Hello');
      const result = applyEnd(msgs);
      expect(result[1].content).toBe('Hello');
      expect(result[1].isStreaming).toBe(false);
    });

    it('does not affect messages that are not streaming', () => {
      const msgs: ChatMessage[] = [
        { id: '1', role: 'assistant', content: 'done', isStreaming: false },
      ];
      const result = applyEnd(msgs);
      expect(result[0].isStreaming).toBe(false);
    });
  });

  describe('error', () => {
    it('appends error text and stops streaming', () => {
      const result = applyError(baseMessages, 'Something went wrong.');
      expect(result[1].content).toContain('Error: Something went wrong.');
      expect(result[1].isStreaming).toBe(false);
    });

    it('appends error after existing content', () => {
      const msgs = applyChunk(baseMessages, 'Partial');
      const result = applyError(msgs, 'Timeout');
      expect(result[1].content).toBe('Partial\n\nError: Timeout');
    });
  });
});
