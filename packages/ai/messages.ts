// Message constructors for chat-style AI APIs.

type AiMessage = {
  role: string,
  content: string,
};

export function systemMessage(content: string): AiMessage {
  return { role: "system", content: content };
}

export function userMessage(content: string): AiMessage {
  return { role: "user", content: content };
}

export function assistantMessage(content: string): AiMessage {
  return { role: "assistant", content: content };
}
