import express from "express";
import { Telegraf } from "telegraf";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const WEBAPP_URL = process.env.WEBAPP_URL;
const PORT = process.env.PORT || 8080;

if (!BOT_TOKEN) {
  console.error("❌ ERROR: BOT_TOKEN is missing");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ========= BOT COMMANDS =========

bot.start((ctx) =>
  ctx.reply("👋 Привет! Открыть магазин:", {
    reply_markup: {
      keyboard: [
        [
          {
            text: "🛒 Открыть магазин",
            web_app: { url: WEBAPP_URL },
          },
        ],
      ],
      resize_keyboard: true,
    },
  })
);

// ========= ORDER API ENDPOINT =========
app.post("/order", async (req, res) => {
  try {
    const order = req.body;

    if (!order || !order.items || !order.total) {
      return res.status(400).json({ error: "Invalid order payload" });
    }

    const text =
      `🆕 *Новый заказ!*\n\n` +
      `📦 Товары:\n${order.items
        .map((i) => `— ${i.name} (${i.price}₽) x${i.quantity}`)
        .join("\n")}\n\n` +
      `💰 *Итого:* ${order.total}₽`;

    await bot.telegram.sendMessage(ADMIN_CHAT_ID, text, {
      parse_mode: "Markdown",
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Ошибка отправки заказа:", err);
    res.status(500).json({ error: "Failed to send order" });
  }
});

// ========= WEBHOOK SETUP =========

// Render URL
const RENDER_URL = "https://tekbir-backend.onrender.com";

// Полный URL Webhook
const WEBHOOK_URL = `${RENDER_URL}/webhook`;

console.log("🌐 Webhook URL:", WEBHOOK_URL);

// Вешаем webhook обработчик ДО запуска сервера
app.use(bot.webhookCallback("/webhook"));

// ========= START SERVER =========
app.listen(PORT, async () => {
  console.log(`🚀 SERVER запущен на порту ${PORT}`);

  try {
    // Ставим webhook
    await bot.telegram.setWebhook(WEBHOOK_URL);
    console.log("✅ Webhook установлен:", WEBHOOK_URL);
  } catch (err) {
    console.error("❌ Ошибка установки Webhook:", err);
  }
});
