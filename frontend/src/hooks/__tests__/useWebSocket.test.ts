import { describe, it, expect, vi } from 'vitest';

// Test the pure message-state reducer logic extracted from useWebSocket
// Rather than rendering the hook (which requires WebSocket + auth), we test
// the state transitions that happen in the onmessage handler.

interface Citation {
  source: string;
  score: number;
  excerpt: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
  citations?: Citation[];
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

function applyCitations(messages: ChatMessage[], citations: Citation[]): ChatMessage[] {
  const updated = [...messages];
  for (let i = updated.length - 1; i >= 0; i--) {
    if (updated[i].role === 'assistant' && !updated[i].isStreaming) {
      updated[i] = { ...updated[i], citations };
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

  describe('citations', () => {
    const doneMsgs: ChatMessage[] = [
      { id: '1', role: 'user', content: 'Hello' },
      { id: '2', role: 'assistant', content: 'Here is the answer.', isStreaming: false },
    ];

    const sampleCitations: Citation[] = [
      { source: 's3://bucket/tenant/doc.pdf', score: 0.92, excerpt: 'Relevant excerpt from doc.' },
      { source: 's3://bucket/tenant/manual.pdf', score: 0.85, excerpt: 'Another relevant snippet.' },
    ];

    it('attaches citations to the last non-streaming assistant message', () => {
      const result = applyCitations(doneMsgs, sampleCitations);
      expect(result[1].citations).toEqual(sampleCitations);
    });

    it('does not modify user messages', () => {
      const result = applyCitations(doneMsgs, sampleCitations);
      expect(result[0].citations).toBeUndefined();
    });

    it('does not attach citations to a still-streaming message', () => {
      // citations arrive after end, so streaming=false; this test ensures we skip streaming ones
      const streamingMsgs: ChatMessage[] = [
        { id: '1', role: 'user', content: 'Q' },
        { id: '2', role: 'assistant', content: '', isStreaming: true },
      ];
      const result = applyCitations(streamingMsgs, sampleCitations);
      // No non-streaming assistant message exists, so no citations applied
      expect(result[1].citations).toBeUndefined();
    });

    it('attaches citations to the last of multiple assistant messages', () => {
      const multiMsgs: ChatMessage[] = [
        { id: '1', role: 'user', content: 'Q1' },
        { id: '2', role: 'assistant', content: 'A1', isStreaming: false },
        { id: '3', role: 'user', content: 'Q2' },
        { id: '4', role: 'assistant', content: 'A2', isStreaming: false },
      ];
      const result = applyCitations(multiMsgs, sampleCitations);
      expect(result[1].citations).toBeUndefined();
      expect(result[3].citations).toEqual(sampleCitations);
    });

    it('preserves existing message content when attaching citations', () => {
      const result = applyCitations(doneMsgs, sampleCitations);
      expect(result[1].content).toBe('Here is the answer.');
      expect(result[1].isStreaming).toBe(false);
    });
  });
});
