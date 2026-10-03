import path from 'node:path';

// Conversation-scoped exclusion. A conversation turn holds its conversation from the moment the request is
// accepted until its response (the SSE `result` / the HTTP body) has been handed to the socket — the
// response is the "post-processing is over" signal, so nothing of the turn runs after the hold is released.
// A turn, a user-message edit, or a conversation end that arrives for a held conversation is refused with
// 409 CONVERSATION_POST_PROCESSING; it is never queued to run later.
const heldConversations = new Set();

export const CONVERSATION_POST_PROCESSING_ERROR_CODE = 'CONVERSATION_POST_PROCESSING';

function conversationPostProcessingError(conversationId) {
  const error = new Error(`conversation ${conversationId} is still post-processing the previous turn`);
  error.statusCode = 409;
  error.errorCode = CONVERSATION_POST_PROCESSING_ERROR_CODE;
  return error;
}

function exclusionKey(root, conversationId) {
  if (!root) throw new Error('conversation exclusion requires root');
  if (typeof conversationId !== 'string' || !conversationId) {
    throw new Error(`conversation exclusion requires a conversation id (got ${JSON.stringify(conversationId)})`);
  }
  return `${path.resolve(root)}\u0000${conversationId}`;
}

// Runs `work` while holding the conversation. Refuses (throws the 409) when the conversation is already held;
// the hold is released when `work` settles, whether it resolves or throws.
export async function runExclusiveConversationWork({ root, conversationId }, work) {
  const key = exclusionKey(root, conversationId);
  if (heldConversations.has(key)) throw conversationPostProcessingError(conversationId);
  heldConversations.add(key);
  try {
    return await work();
  } finally {
    heldConversations.delete(key);
  }
}
