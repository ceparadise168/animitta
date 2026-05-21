# Direction Δ: Conversational Sutra / 自在對話優先

**Status**: Applied in `prompt-v3`
**Date**: 2026-05-21
**Replaces**: β' Concrete Poet / Image-first

## Review Findings

The product was drifting toward a scripture-and-style performance. The LINE entry point said "今天想跟你分享一句金剛經" and immediately asked a koan-like question. That makes the user feel tested, not welcomed. When the user later says "最近很煩惱", the bot is still carrying the previous literary frame.

The v2 system prompt also made the wrong thing primary. "Image-first" was named as the core discipline, while emotional presence was mostly defined by prohibitions. That taught the model to produce concrete images even when the user needed plain human pacing. The line "你不是來照顧人的、是給畫面的人" was especially misaligned with the goal of letting people vent.

The examples reinforced the same issue: many replies were elegant, but too authored. The bot often occupied more conversational space than the user. For a LINE product, that creates friction because most users are not asking to read a short essay; they are trying to keep talking.

## Product Positioning

無相界 is now positioned as:

> A low-pressure LINE conversation space with Diamond Sutra wisdom in the background.

The primary product job is not "deliver a quote" or "sound Zen". It is to let a person speak freely, then offer one of four things depending on the moment:

1. Ordinary presence when the user wants to vent
2. Practical framing when the user asks what to do
3. Buddhist explanation when the user asks about the Dharma
4. Diamond Sutra insight when the conversation naturally touches attachment, identity, form, non-abiding, or uncertainty

金剛經 wisdom is treated as a lens, not a script. The bot should help users see what they are holding, where a thought hardened into "truth", or how to act without being fully captured by the result.

## Content Design

The entry content changed from a quote-first ritual to a low-pressure invitation. `@隨意聊聊` now starts with messages like:

> 你可以講一件煩事、一個卡住的念頭，或問我一句金剛經。不用整理，直接丟一句現在最佔位置的話就好

This preserves the Diamond Sutra option while removing the feeling of a quiz. The welcome message and about copy now say plainly that users can chat, vent, ask life questions, or ask about scripture. The product promise is "自在聊天", not "我分享一句經文".

## Prompt Design

`prompt-v3` moves from "Image-first" to "自在對話優先".

The new priority stack is:

1. Identify what the user is seeking: venting, chatting, methods, Buddhist explanation, inspiration, testing, or crisis help
2. Decide whether scripture is helpful at all
3. Use images only when they help the user keep speaking or see the situation more clearly

The prompt explicitly says:

- 金剛經是底色，不是每次都要端出來
- 使用者說「煩」「累」「卡」時，第一件事不是寫出好看的比喻
- 引經文時要 open space, not close the conversation

## Before / After

Before:

> 最近很煩惱，像抽屜卡住，拉得出一點，又卡回去...

After target:

> 那先不講經文
>
> 煩的時候不用整理成大道理。你直接丟一件現在最佔位置的事就好

The second version is less showy but gives the user more room. That is the desired product direction.

## Files Changed

- `lambda/prompt.mjs`: replaced v2 image-first prompt with v3 conversational-sutra prompt
- `lambda/commands.mjs`: redesigned casual chat starters and about copy
- `lambda/index.mjs`: updated welcome message and rich menu description
- `lambda/services/chat.mjs`, `lambda/line.mjs`: restored text quick-reply support described by existing tests
- `test/prompt.test.mjs`, `test/commands.test.mjs`, `test/chat.test.mjs`: added/updated product contract tests
