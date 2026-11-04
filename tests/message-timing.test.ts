import {expect, it} from 'vitest';
import {historyMessages, mergeMessages, nativeMessage} from '../src/harness/conversation-model';
it('preserves explicit timing across history, native compact tool data and later partial updates', () => {
    const start = 1791458565000, end = start + 11000;
    const messages = historyMessages({turns: [{id: 'turn', items: [
        {id: 'u', type: 'userMessage', content: [{text: 'Prompt'}], submittedAt: start},
        {id: 'a', type: 'agentMessage', text: 'Answer', startedAt: start, completedAt: end, status: 'completed'},
    ]}]} as never);
    expect(messages[0].submittedAt).toBe(start); expect(messages[1]).toMatchObject({startedAt: start, completedAt: end});
    const later = nativeMessage({id: 'a', type: 'agentMessage', text: 'Answer', status: 'completed'}, 'fallback')!;
    expect(mergeMessages(messages, [later])[1]).toMatchObject({startedAt: start, completedAt: end});
});
it('does not reinterpret a legacy timestamp or turn creation as response completion', () => {
    const message = historyMessages({turns: [{startedAt: 1791458565000, items: [{id: 'a', type: 'agentMessage', text: 'Legacy', timestamp: 1791458565000}]}]} as never)[0];
    expect(message.timestamp).toBe(1791458565000); expect(message.completedAt).toBeUndefined(); expect(message.startedAt).toBeUndefined();
});
