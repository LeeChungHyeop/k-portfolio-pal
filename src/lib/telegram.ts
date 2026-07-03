// ── Telegram Bot Types ────────────────────────────────────────────────────
interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

// ── Anthropic API ─────────────────────────────────────────────────────────
interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
}

async function askClaude(apiKey: string, userText: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: userText }],
    }),
  });

  if (!res.ok) {
    console.error("[claude] API error:", res.status, await res.text());
    return "죄송해요, 지금 답변을 생성할 수 없어요.";
  }

  const data = (await res.json()) as AnthropicResponse;
  return data.content.find((b) => b.type === "text")?.text ?? "응답을 파싱할 수 없어요.";
}

// ── Telegram API Calls ────────────────────────────────────────────────────
async function sendMessage(botToken: string, chatId: number, text: string): Promise<void> {
  const res = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    }
  );
  if (!res.ok) {
    console.error("[telegram] sendMessage failed:", res.status, await res.text());
  }
}

// ── AI Handler ────────────────────────────────────────────────────────────
async function handleUpdate(
  update: TelegramUpdate,
  botToken: string,
  anthropicApiKey: string
): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;

  const reply = await askClaude(anthropicApiKey, msg.text);
  await sendMessage(botToken, msg.chat.id, reply);
}

// ── Webhook Entry Point ───────────────────────────────────────────────────
export async function handleWebhookRequest(
  request: Request,
  botToken: string | undefined,
  anthropicApiKey: string | undefined,
  webhookSecret: string | undefined,
): Promise<Response> {
  if (!botToken) {
    console.error("[telegram] TELEGRAM_BOT_TOKEN is not set");
    return new Response("Bot token not configured", { status: 500 });
  }
  if (!anthropicApiKey) {
    console.error("[telegram] ANTHROPIC_API_KEY is not set");
    return new Response("Anthropic API key not configured", { status: 500 });
  }
  // 텔레그램이 보낸 요청인지 검증 (setWebhook 등록 시 지정한 secret_token과 대조)
  if (webhookSecret && request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== webhookSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  await handleUpdate(update, botToken, anthropicApiKey);
  return new Response("OK", { status: 200 });
}
