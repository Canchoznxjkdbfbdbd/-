"""НутриКод — тонкий Telegram-клиент к POST /api/bot/chat (без локального Gemini)."""

from __future__ import annotations

import logging
import os
import re
from typing import Any, Dict, List, Optional, Tuple

import aiohttp
from aiogram import Bot, Dispatcher, F
from aiogram.enums import ChatAction
from aiogram.filters import CommandStart
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, Message
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
MAX_HISTORY = 20
BTN_LABEL_MAX = 36
LINKS_KEYBOARD_MAX = 10

STORE_NAMES = {
    "vkusvill": "ВкусВилл",
    "vipfish": "Важная рыба",
    "befit": "BeFit",
    "hvalwaters": "Хваловская",
    "growfood": "GrowFood",
}

# Legacy markdown link lists from older API builds — strip when buttons are present.
_LEGACY_LINK_BLOCK_RE = re.compile(
    r"\n\n(?:Собрать корзину:|Полезные ссылки:)(?:\n.*)+$",
    re.DOTALL,
)

# In-memory history per Telegram chat_id (lost on process restart).
chat_histories: Dict[int, List[dict]] = {}

dp = Dispatcher()


def _trim_history(history: List[dict]) -> None:
    if len(history) > MAX_HISTORY:
        del history[:-MAX_HISTORY]


def _truncate_label(text: str, max_len: int = BTN_LABEL_MAX) -> str:
    s = re.sub(r"\s+", " ", str(text or "").strip())
    if len(s) <= max_len:
        return s
    if max_len <= 1:
        return s[:max_len]
    return s[: max_len - 1].rstrip() + "…"


def _button_label(item: dict) -> str:
    label = str(item.get("label") or "").strip() or "Ссылка"
    store = str(item.get("store") or "").strip().lower()
    store_name = STORE_NAMES.get(store, "")
    if store_name:
        return _truncate_label(f"{store_name} — {label}")
    return _truncate_label(label)


def _normalize_links(raw: Any) -> List[dict]:
    if not isinstance(raw, list):
        return []
    out: List[dict] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            continue
        if url in seen:
            continue
        seen.add(url)
        label = str(item.get("label") or "").strip() or "Ссылка"
        store = str(item.get("store") or "").strip() or None
        entry: dict = {"label": label, "url": url}
        if store:
            entry["store"] = store
        out.append(entry)
        if len(out) >= LINKS_KEYBOARD_MAX:
            break
    return out


def build_links_keyboard(links: List[dict]) -> Optional[InlineKeyboardMarkup]:
    if not links:
        return None
    rows: List[List[InlineKeyboardButton]] = []
    row: List[InlineKeyboardButton] = []
    for item in links:
        btn = InlineKeyboardButton(text=_button_label(item), url=item["url"])
        row.append(btn)
        if len(row) == 2:
            rows.append(row)
            row = []
    if row:
        rows.append(row)
    return InlineKeyboardMarkup(inline_keyboard=rows)


def prepare_reply_text(reply: str, has_buttons: bool) -> str:
    """Prefer buttons for product URLs; drop legacy duplicate URL lists from reply text."""
    text = (reply or "").strip()
    if not has_buttons:
        return text
    stripped = _LEGACY_LINK_BLOCK_RE.sub("", text).strip()
    return stripped or text


async def ask_nutrikod(
    session: aiohttp.ClientSession, messages: List[dict]
) -> Optional[Tuple[str, List[dict]]]:
    """POST JSON {messages} → (reply, links) or None on transport / non-200."""
    try:
        async with session.post(
            NUTRIKOD_API_URL,
            json={"messages": messages},
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
            if not isinstance(data, dict):
                log.warning("API 200 with non-object JSON")
                return None
            reply = data.get("reply")
            if not isinstance(reply, str) or not reply.strip():
                log.warning("API 200 without reply field")
                return None
            links = _normalize_links(data.get("links"))
            return reply.strip(), links
    except Exception:
        log.exception("API request failed")
        return None


@dp.message(CommandStart())
async def on_start(message: Message) -> None:
    chat_histories.pop(message.chat.id, None)
    await message.answer(
        "Привет! Я НутриКод в Telegram. Напиши вопрос про еду и рацион — отвечу так же, как на сайте."
    )


@dp.message(F.text)
async def on_text(message: Message, http: aiohttp.ClientSession) -> None:
    text = (message.text or "").strip()
    if not text:
        return
    chat_id = message.chat.id
    history = chat_histories.setdefault(chat_id, [])
    history.append({"role": "user", "content": text})
    _trim_history(history)

    await message.bot.send_chat_action(chat_id, ChatAction.TYPING)
    result = await ask_nutrikod(http, history)
    if result is None:
        # Drop the user turn so a retry does not duplicate it.
        if history and history[-1].get("role") == "user":
            history.pop()
        await message.answer(SERVICE_UNAVAILABLE)
        return

    reply, links = result
    keyboard = build_links_keyboard(links)
    reply_text = prepare_reply_text(reply, keyboard is not None)

    history.append({"role": "assistant", "content": reply_text})
    _trim_history(history)

    # Telegram hard limit ~4096; split long replies safely.
    # Attach inline URL buttons only to the last chunk.
    chunk = 4000
    parts = [reply_text[i : i + chunk] for i in range(0, len(reply_text), chunk)] or [reply_text]
    for i, part in enumerate(parts):
        if i == len(parts) - 1 and keyboard is not None:
            await message.answer(part, reply_markup=keyboard)
        else:
            await message.answer(part)


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
