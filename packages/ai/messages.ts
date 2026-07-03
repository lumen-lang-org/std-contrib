// Message constructors for chat-style AI APIs.

type LumenAiMessage = {
  role: string,
  content: string,
};

export function systemMessage(content: string): LumenAiMessage {
  return { role: "system", content: content };
}

export function userMessage(content: string): LumenAiMessage {
  return { role: "user", content: content };
}

export function assistantMessage(content: string): LumenAiMessage {
  return { role: "assistant", content: content };
}
