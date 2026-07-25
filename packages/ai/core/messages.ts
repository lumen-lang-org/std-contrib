// Message constructors for chat-style AI APIs.

export type Message = {
  role: string,
  content: string,
};

export function systemMessage(content: string): Message {
  return { role: "system", content: content };
}

export function userMessage(content: string): Message {
  return { role: "user", content: content };
}

export function assistantMessage(content: string): Message {
  return { role: "assistant", content: content };
}
