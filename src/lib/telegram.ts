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

// ── Echo Handler ──────────────────────────────────────────────────────────
async function handleUpdate(update: TelegramUpdate, botToken: string): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return; // ignore non-text messages (photos, stickers, etc.)

  await sendMessage(botToken, msg.chat.id, msg.text);
}

// ── Webhook Entry Point ───────────────────────────────────────────────────
export async function handleWebhookRequest(
  request: Request,
  botToken: string | undefined
): Promise<Response> {
  if (!botToken) {
    console.error("[telegram] TELEGRAM_BOT_TOKEN is not set");
    return new Response("Bot token not configured", { status: 500 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Process the update, then always acknowledge with 200
  // (Telegram retries if it doesn't get 2xx within ~55 s)
  await handleUpdate(update, botToken);
  return new Response("OK", { status: 200 });
}
