// =============================
//      IMPORTS & CONFIG
// =============================
import fs from "fs";
import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import { Telegraf, Markup } from "telegraf";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env
dotenv.config({ path: path.join(__dirname, ".env") });

// ENV
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const WEBAPP_URL = process.env.WEBAPP_URL;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

console.log("ENV CHECK:");
console.log("BOT_TOKEN:", BOT_TOKEN ? "OK" : "❌ MISSING");
console.log("ADMIN_CHAT_ID:", ADMIN_CHAT_ID);
console.log("WEBAPP_URL:", WEBAPP_URL);
console.log("GOOGLE_SHEET_ID:", GOOGLE_SHEET_ID);

if (!BOT_TOKEN || !ADMIN_CHAT_ID || !WEBAPP_URL || !GOOGLE_SHEET_ID) {
  console.error("❌ ERROR: Missing environment variables");
  process.exit(1);
}

// =============================
//       GOOGLE SHEETS
// =============================
const SERVICE_KEY = path.join(__dirname, "service-key.json");

if (!fs.existsSync(SERVICE_KEY)) {
  throw new Error("❌ Нет файла service-key.json в backend/");
}

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(fs.readFileSync(SERVICE_KEY)),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// =============================
//        TELEGRAM BOT
// =============================
const bot = new Telegraf(BOT_TOKEN);

// Состояние диалога по добавлению товара
let admin_state = {};

// Список всех сообщений (бота и админа) в процессе добавления
let admin_messages = {};

// Для удаления товаров — id сообщений со списком
let delete_messages = {};

// --- helper: запомнить id сообщения в текущем чате админа
function trackMessage(ctx, messageId) {
  const uid = ctx.from.id.toString();
  if (!admin_messages[uid]) admin_messages[uid] = [];
  admin_messages[uid].push(messageId);
}

// --- helper: удалить все сообщения сценария добавления товара
async function clearAddDialog(ctx) {
  const uid = ctx.from.id.toString();
  const list = admin_messages[uid] || [];

  for (const id of list) {
    try {
      await ctx.telegram.deleteMessage(uid, id);
    } catch (e) {}
  }

  admin_messages[uid] = [];
}

// /start
bot.start((ctx) => {
  const isAdmin = ctx.from.id.toString() === ADMIN_CHAT_ID;

  const buttons = [
    [
      {
        text: "🛍 Открыть магазин",
        web_app: { url: WEBAPP_URL }
      }
    ]
  ];

  if (isAdmin) {
    buttons.push(
      [{ text: "➕ Добавить товар", callback_data: "add_product" }],
      [{ text: "🗑 Удалить товар", callback_data: "delete_product_list" }]
    );
  }

  ctx.reply("Добро пожаловать в TekBir!", {
    reply_markup: {
      inline_keyboard: buttons
    }
  });
});

// =============================
//   ADMIN — ADD PRODUCT
// =============================

// Кнопка "Добавить товар"
bot.action("add_product", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_CHAT_ID) {
    return ctx.reply("⛔ Нет доступа");
  }

  admin_state[ctx.from.id] = {
    step: "name",
    photos: [],
  };

  const m = await ctx.reply("Введите название товара:");
  trackMessage(ctx, m.message_id);
});

// Обработка текстовых сообщений администратора
bot.on("text", async (ctx) => {
  const uid = ctx.from.id.toString();
  const st = admin_state[uid];
  if (!st) return; // если админ сейчас ничего не добавляет — выходим

  // Запоминаем СООБЩЕНИЕ АДМИНА
  trackMessage(ctx, ctx.message.message_id);

  const msg = ctx.message.text.trim().toLowerCase();

  switch (st.step) {
    case "name": {
      st.name = ctx.message.text.trim();
      st.step = "price";
      const r = await ctx.reply("Введите цену товара:");
      trackMessage(ctx, r.message_id);
      return;
    }

    case "price": {
      st.price = ctx.message.text.trim();
      st.step = "category";
      const r = await ctx.reply("Введите категорию:");
      trackMessage(ctx, r.message_id);
      return;
    }

    case "category": {
      st.category = ctx.message.text.trim();
      st.step = "condition";
      const r = await ctx.reply("Введите состояние (Новый / Б/У):");
      trackMessage(ctx, r.message_id);
      return;
    }

    case "condition": {
      st.condition = ctx.message.text.trim();
      st.step = "capacity";
      const r = await ctx.reply(
        "Введите память (например 128GB) или '-' если памяти нет:"
      );
      trackMessage(ctx, r.message_id);
      return;
    }

    case "capacity": {
      st.capacity =
        ctx.message.text.trim() === "-" ? "" : ctx.message.text.trim();
      st.step = "color";
      const r = await ctx.reply("Введите цвет товара:");
      trackMessage(ctx, r.message_id);
      return;
    }

    case "color": {
      st.color = ctx.message.text.trim();
      st.step = "description";
      const r = await ctx.reply("Введите описание товара:");
      trackMessage(ctx, r.message_id);
      return;
    }

    case "description": {
      st.description = ctx.message.text.trim();
      st.step = "photos";
      const r = await ctx.reply(
        "Теперь отправьте *одно или несколько фото* товара.\n\n" +
          "Когда закончите — отправьте сообщение: **готово**",
        { parse_mode: "Markdown" }
      );
      trackMessage(ctx, r.message_id);
      return;
    }

    case "photos": {
      if (msg === "готово") {
        if (!st.photos.length) {
          const r = await ctx.reply(
            "❗ Вы ещё не добавили ни одного фото. Отправьте хотя бы одно фото товара."
          );
          trackMessage(ctx, r.message_id);
          return;
        }

        st.step = "confirm";

        const r = await ctx.reply(
          `📦 Новый товар:\n\n` +
            `Название: ${st.name}\n` +
            `Цена: ${st.price}\n` +
            `Категория: ${st.category}\n` +
            `Состояние: ${st.condition}\n` +
            `Память: ${st.capacity || "-"}\n` +
            `Цвет: ${st.color || "-"}\n` +
            `Описание: ${st.description || "-"}\n` +
            `Фото: ${st.photos.length} шт.`,
          Markup.inlineKeyboard([
            [Markup.button.callback("✅ Добавить", "confirm_add")],
            [Markup.button.callback("❌ Отмена", "cancel_add")],
          ])
        );
        trackMessage(ctx, r.message_id);
        return;
      } else {
        const r = await ctx.reply(
          "Отправьте фото товара. Когда закончите — напишите *готово*.",
          { parse_mode: "Markdown" }
        );
        trackMessage(ctx, r.message_id);
        return;
      }
    }
  }
});

// Обработка фото от админа (много фото)
bot.on("photo", async (ctx) => {
  const uid = ctx.from.id.toString();
  const st = admin_state[uid];
  if (!st || st.step !== "photos") return;

  // Запоминаем фото-сообщение админа
  trackMessage(ctx, ctx.message.message_id);

  const photoSizes = ctx.message.photo;
  const biggest = photoSizes[photoSizes.length - 1];

  const file = await ctx.telegram.getFile(biggest.file_id);
  const filePath = file.file_path;

  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  st.photos.push(url);

  const r = await ctx.reply(
    `Фото добавлено (${st.photos.length}). ` +
      `Можете отправить ещё или напишите «готово».`
  );
  trackMessage(ctx, r.message_id);
});

// Отмена добавления товара
bot.action("cancel_add", async (ctx) => {
  const uid = ctx.from.id.toString();
  delete admin_state[uid];

  // чистим весь диалог добавления
  await clearAddDialog(ctx);

  const m = await ctx.reply("❌ Добавление товара отменено.");
  setTimeout(() => {
    ctx.deleteMessage(m.message_id).catch(() => {});
  }, 2000);
});

// Подтверждение добавления товара
bot.action("confirm_add", async (ctx) => {
  const uid = ctx.from.id.toString();
  const st = admin_state[uid];
  if (!st) return ctx.reply("Ошибка: нет данных для добавления");

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Лист1!A:O",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          [
            Date.now().toString(), // A — ID
            st.name, // B — Название
            st.price, // C — Цена
            st.category, // D — Категория
            "", // E — Бренд
            st.condition, // F — Состояние
            st.capacity, // G — Память
            st.photos.join(" "), // H — Фото (URL через пробел)
            st.description || "", // I — Описание
            st.color || "", // J — Цвет
            1, // K — Количество
            "Свободен", // L — Статус
            "", // M — Имя покупателя
            "", // N — Телефон
            "", // O — Username
          ],
        ],
      },
    });

    delete admin_state[uid];

    // ЧИСТИМ ВЕСЬ ДИАЛОГ добавления товара (вопросы, ответы, фото)
    await clearAddDialog(ctx);

    const m = await ctx.reply("✅ Товар успешно добавлен!");
    setTimeout(() => {
      ctx.deleteMessage(m.message_id).catch(() => {});
    }, 2000);
  } catch (err) {
    console.error("Ошибка при записи в Google Sheets:", err);
    ctx.reply("⚠️ Ошибка при добавлении товара в таблицу");
  }
});

// =============================
//   ADMIN — DELETE PRODUCT
// =============================

bot.action("delete_product_list", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_CHAT_ID) {
    return ctx.reply("⛔ Нет доступа");
  }

  const uid = ctx.from.id.toString();
  delete_messages[uid] = [];

  ctx.answerCbQuery();

  const sheet = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: "Лист1!A2:B", // без заголовка
  });

  const rows = sheet.data.values || [];

  if (rows.length === 0) {
    return ctx.reply("⚠️ Товаров нет");
  }

  const buttons = rows.map((r) => [
    Markup.button.callback(r[1], `delete_${r[0]}`),
  ]);

  const sent = await ctx.reply(
    "🗑 Выберите товар для удаления:",
    Markup.inlineKeyboard(buttons)
  );

  delete_messages[uid].push(sent.message_id);
});

bot.action(/delete_(.+)/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_CHAT_ID) {
    return ctx.reply("⛔ Нет доступа");
  }

  const uid = ctx.from.id.toString();
  const idToDelete = ctx.match[1];
  ctx.answerCbQuery();

  try {
    // Удаляем сообщение со списком товаров
    if (delete_messages[uid]) {
      for (const msgId of delete_messages[uid]) {
        ctx.deleteMessage(msgId).catch(() => {});
      }
      delete delete_messages[uid];
    }

    const sheet = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Лист1!A2:J", // без заголовка
    });

    const rows = sheet.data.values || [];
    const index = rows.findIndex((r) => r[0] === idToDelete);

    if (index === -1) {
      return ctx.reply("❌ Товар не найден");
    }

    // удаляем строку
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: GOOGLE_SHEET_ID,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: 0,
                dimension: "ROWS",
                startIndex: index + 1, // 0 — заголовок, 1 — строка A2
                endIndex: index + 2,
              },
            },
          },
        ],
      },
    });

    const msg = await ctx.reply("🗑 Товар удалён!");
    setTimeout(() => {
      ctx.deleteMessage(msg.message_id).catch(() => {});
    }, 2000);
  } catch (err) {
    console.error(err);
    ctx.reply("⚠️ Ошибка удаления товара");
  }
});

// =============================
//   ADMIN — CONFIRM ORDER (список резервов)
// =============================

bot.action("confirm_order_list", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_CHAT_ID) {
    return ctx.reply("⛔ Нет доступа");
  }

  ctx.answerCbQuery();

  const sheet = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: "Лист1!A2:O", // без заголовка
  });

  const rows = sheet.data.values || [];

  const reserved = rows.filter((r) => r[11] === "Резерв");

  if (!reserved.length) {
    return ctx.reply("Нет заказов в резерве.");
  }

  const buttons = reserved.map((r) => {
    const id = r[0];
    const name = r[1];
    const buyerName = r[12] || "";
    const qty = r[10] || "";
    return [
      Markup.button.callback(
        `${name} (${buyerName || "без имени"}, кол-во: ${qty || 1})`,
        `approve_${id}` // этот approve_ будет обработан НОВЫМ хендлером ниже
      ),
    ];
  });

  ctx.reply(
    "Выберите заказ для подтверждения:",
    Markup.inlineKeyboard(buttons)
  );
});

// ВАЖНО: здесь мы больше НЕ объявляем старый bot.action(/approve_(.+)/)
// потому что ниже будет новый универсальный approve_/cancel_ для всех заказов

// =============================
//   MiniApp → Telegram Order
// =============================
bot.on("web_app_data", async (ctx) => {
  try {
    const data = JSON.parse(ctx.webAppData.data);

    const text =
      `🛒 Новый заказ!\n\n` +
      `Имя: ${data.name}\n` +
      `Телефон: ${data.phone}\n` +
      (data.contactMethod
        ? `Как связаться: ${data.contactMethod}\n`
        : "") +
      (data.contactMethod === "telegram" && data.tg_username
        ? `Username: @${data.tg_username}\n`
        : "") +
      `Доставка: ${data.deliveryMethod} (${data.deliveryType})\n` +
      `Адрес: ${data.address}\n` +
      `Комментарий: ${data.comment}\n\n` +
      `Товары:\n` +
      data.items
        .map(
          (i) =>
            `• ${i.name} (${i.capacity || "-"}) x${i.qty} = ${
              i.qty * i.price
            }₽`
        )
        .join("\n") +
      `\n\n💰 Итого: ${data.total}₽`;

    // отправляем заказ админу (текст)
    await ctx.telegram.sendMessage(ADMIN_CHAT_ID, text);

    // второе сообщение — с кнопками Подтвердить / Отменить
    const firstItem = data.items && data.items[0];
    if (firstItem && firstItem.id) {
      await ctx.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `Что делаем с заказом по товару ID: ${firstItem.id}?`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Подтвердить",
                  callback_data: `approve_${firstItem.id}`,
                },
              ],
              [
                {
                  text: "❌ Отменить",
                  callback_data: `cancel_${firstItem.id}`,
                },
              ],
            ],
          },
        }
      );
    }

    await ctx.reply("Спасибо! Ваш заказ отправлен!");

    // =============================
    //  ОБНОВЛЕНИЕ ТОВАРОВ В ТАБЛИЦЕ (РЕЗЕРВ)
    // =============================

    for (const item of data.items) {
      const productId = item.id; // id товара из mini-app (должен совпадать с колонкой A)

      const sheet = await sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: "Лист1!A2:O", // без заголовка
      });

      const rows = sheet.data.values || [];

      const index = rows.findIndex((r) => r[0] === productId);

      if (index !== -1) {
        // L — статус
        rows[index][11] = "Резерв";

        // M — имя, N — телефон
        rows[index][12] = data.name;
        rows[index][13] = data.phone;

        // O — username, только если выбрал Telegram
        if (data.contactMethod === "telegram") {
          rows[index][14] = data.tg_username || "";
        }

        await sheets.spreadsheets.values.update({
          spreadsheetId: GOOGLE_SHEET_ID,
          range: `Лист1!A${index + 2}:O${index + 2}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [rows[index]] },
        });

        console.log("✓ Обновлено по ID (Резерв):", productId);
      } else {
        console.log("⚠️ Не найден товар ID:", productId);
      }
    }
  } catch (err) {
    console.error("web_app_data ERROR:", err);
    ctx.reply("Ошибка заказа ⚠️");
  }
});

// =============================
//   MiniApp / SITE → /order (HTTP)
// =============================
const app = express();
app.use(express.json());

// DIRECT POST /order from website / mini-app
app.post("/order", async (req, res) => {
  try {
    const data = req.body;

    // ---------- 1. Сообщение админу ----------
    const text =
      `🛒 Новый заказ (сайта)!\n\n` +
      `Имя: ${data.name}\n` +
      `Телефон: ${data.phone}\n` +
      `Как связаться: ${data.contactMethod}\n` +
      (data.tg_username ? `Username: @${data.tg_username}\n` : "") +
      `Доставка: ${data.deliveryMethod} (${data.deliveryType})\n` +
      `Адрес: ${data.address}\n` +
      `Комментарий: ${data.comment || "-"}\n\n` +
      `Товары:\n` +
      data.items
        .map(
          (i) =>
            `📱 ${i.name}\nОбъём: ${i.capacity}\nЦена: ${i.price}₽\nКол-во: ${i.qty}\nСумма: ${i.qty * i.price}₽`
        )
        .join("\n\n") +
      `\n\n💰 Итого: ${data.total}₽`;

    // Основной текст заказа
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, text);

    // ---------- 1.1. Сообщение с кнопками ----------
    if (data.items && data.items[0] && data.items[0].id) {
      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `ID товара: ${data.items[0].id}\nЧто делаем с заказом?`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Подтвердить",
                  callback_data: `approve_${data.items[0].id}`,
                },
              ],
              [
                {
                  text: "❌ Отменить",
                  callback_data: `cancel_${data.items[0].id}`,
                },
              ],
            ],
          },
        }
      );
    }

    // ---------- 2. Обновляем таблицу ----------
    const sheet = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Лист1!A:O",
    });

    const rows = sheet.data.values || [];

    for (const item of data.items) {
      const id = item.id;

      const index = rows.findIndex((r) => r[0] === id);

      if (index === -1) {
        console.log("⚠️ Товар не найден в таблице:", id);
        continue;
      }

      rows[index][11] = "Резерв"; // L — статус
      rows[index][12] = data.name; // M — имя
      rows[index][13] = data.phone; // N — телефон
      rows[index][14] = data.tg_username || ""; // O — username

      await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: `Лист1!A${index + 1}:O${index + 1}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [rows[index]] },
      });

      console.log("✓ Обновлён статус товара:", id);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Ошибка /order:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================
//   КНОПКИ: Подтвердить / Отменить
// =============================
bot.action(/approve_(.+)/, async (ctx) => {
  const id = ctx.match[1];
  ctx.answerCbQuery("Подтверждаю...");

  try {
    const sheet = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Лист1!A:O",
    });

    const rows = sheet.data.values || [];
    const index = rows.findIndex((r) => r[0] === id);

    if (index === -1) {
      return ctx.editMessageText("❌ Товар не найден");
    }

    // Статус "Продан" и количество 0
    rows[index][11] = "Продан"; // L — статус
    rows[index][10] = "0"; // K — количество

    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `Лист1!A${index + 1}:O${index + 1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [rows[index]] },
    });

    await ctx.editMessageText("✅ Заказ подтверждён. Товар продан.");
  } catch (err) {
    console.error("approve_ ERROR:", err);
    ctx.reply("⚠️ Ошибка при подтверждении заказа");
  }
});

bot.action(/cancel_(.+)/, async (ctx) => {
  const id = ctx.match[1];
  ctx.answerCbQuery("Отменяю...");

  try {
    const sheet = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Лист1!A:O",
    });

    const rows = sheet.data.values || [];
    const index = rows.findIndex((r) => r[0] === id);

    if (index === -1) {
      return ctx.editMessageText("❌ Товар не найден");
    }

    // Возвращаем в Свободен и чистим данные покупателя
    rows[index][11] = "Свободен"; // L — статус
    rows[index][12] = ""; // M — имя
    rows[index][13] = ""; // N — телефон
    rows[index][14] = ""; // O — username

    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `Лист1!A${index + 1}:O${index + 1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [rows[index]] },
    });

    await ctx.editMessageText("🔄 Резерв снят. Товар снова свободен.");
  } catch (err) {
    console.error("cancel_ ERROR:", err);
    ctx.reply("⚠️ Ошибка при отмене заказа");
  }
});

// =============================
//      FRONTEND STATIC
// =============================


// =============================
//          START SERVER
// =============================
const PORT = 8080;
app.listen(PORT, () =>
  console.log(`🚀 SERVER запущен: http://localhost:${PORT}`)
);

// =============================
//          START BOT
// =============================
bot.launch();
console.log("🤖 БОТ запущен!");
