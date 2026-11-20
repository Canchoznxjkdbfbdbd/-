"""НутриКод — тонкий Telegram-клиент к POST /api/bot/chat (без локального Gemini)."""

from __future__ import annotations

import logging
import os
from typing import Optional

import aiohttp
from aiogram import Bot, Dispatcher, F
from aiogram.enums import ChatAction
from aiogram.filters import CommandStart
from aiogram.types import Message
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("nutrikod-bot")

TELEGRAM_BOT_TOKEN = (os.getenv("TELEGRAM_BOT_TOKEN") or "").strip()
BOT_API_KEY = (os.getenv("BOT_API_KEY") or "").strip()
NUTRIKOD_API_URL = (
    os.getenv("NUTRIKOD_API_URL") or "https://nutricode.online/api/bot/chat"
).strip()

SERVICE_UNAVAILABLE = "Сервис временно недоступен, попробуй позже"

dp = Dispatcher()


async def ask_nutrikod(session: aiohttp.ClientSession, text: str) -> Optional[str]:
    """POST JSON {message} → reply string, or None on transport / non-200."""
    try:
        async with session.post(
            NUTRIKOD_API_URL,
            json={"message": text},
            headers={
                "Content-Type": "application/json",
                "X-Bot-Key": BOT_API_KEY,
            },
            timeout=aiohttp.ClientTimeout(total=120),
        ) as resp:
            if resp.status != 200:
                body = await resp.text()
                log.warning("API status=%s body=%s", resp.status, body[:200])
                return None
            data = await resp.json(content_type=None)
            reply = data.get("reply") if isinstance(data, dict) else None
            if not isinstance(reply, str) or not reply.strip():
                log.warning("API 200 without reply field")
                return None
            return reply.strip()
    except Exception:
        log.exception("API request failed")
        return None


@dp.message(CommandStart())
async def on_start(message: Message) -> None:
    await message.answer(
        "Привет! Я НутриКод в Telegram. Напиши вопрос про еду и рацион — отвечу так же, как на сайте."
    )


@dp.message(F.text)
async def on_text(message: Message, http: aiohttp.ClientSession) -> None:
    text = (message.text or "").strip()
    if not text:
        return
    await message.bot.send_chat_action(message.chat.id, ChatAction.TYPING)
    reply = await ask_nutrikod(http, text)
    if reply is None:
        await message.answer(SERVICE_UNAVAILABLE)
        return
    # Telegram hard limit ~4096; split long replies safely.
    chunk = 4000
    for i in range(0, len(reply), chunk):
        await message.answer(reply[i : i + chunk])


async def main() -> None:
    if not TELEGRAM_BOT_TOKEN:
        raise SystemExit("TELEGRAM_BOT_TOKEN не задан")
    if not BOT_API_KEY:
        raise SystemExit("BOT_API_KEY не задан")

    bot = Bot(token=TELEGRAM_BOT_TOKEN)
    session = aiohttp.ClientSession()
    try:
        log.info("Starting bot → %s", NUTRIKOD_API_URL)
        await dp.start_polling(bot, http=session)
    finally:
        await session.close()
        await bot.session.close()


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
