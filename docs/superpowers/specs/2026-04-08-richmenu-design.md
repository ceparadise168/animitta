# Rich Menu + Commands Design Spec

## Overview

Add a LINE Rich Menu with three buttons (隨意聊聊, 重新開始, 回饋) and the corresponding Lambda handler logic for each command.

## Rich Menu Layout

Three equal-width columns, bottom-fixed:

```
┌──────────────┬──────────────┬──────────────┐
│              │              │              │
│  🌿 隨意聊聊  │  🔄 重新開始  │  💬 回饋     │
│              │              │              │
└──────────────┴──────────────┴──────────────┘
```

Size: 2500 x 843 px (LINE rich menu compact size).

## Commands

All commands use `@` prefix to distinguish from regular messages.

### 1. 隨意聊聊 (`@隨意聊聊`)

Bot randomly picks a scripture quote from the prompt's scripture library and starts a casual conversation. The tone should be light and inviting, not counseling-mode.

Example response: "嗨～今天想跟你分享金剛經的一句話：「過去心不可得，現在心不可得，未來心不可得。」你有沒有想過，如果三種心都不可得，那現在在想事情的是誰？😄"

### 2. 重新開始 (`@重新開始`)

**Flow:**
1. User taps button → sends `@重新開始`
2. Bot replies: "確定要重新開始嗎？之前的對話記憶會清空喔" with Quick Reply buttons: "確定" / "取消"
3. If "確定" (postback `confirm:clear`): delete all TURN# and SUMMARY items for this user from DynamoDB → reply "記憶已清空，我們重新開始吧 ✨"
4. If "取消" (postback `confirm:cancel`): reply "好的，那我們繼續 😊"

### 3. 回饋 (`@回饋`)

**Flow:**
1. User taps button → sends `@回饋`
2. Bot replies: "這次聊天覺得如何？" with Quick Reply buttons: "👍 有收穫" / "👋 還好"
3. User taps → sends postback `feedback:good` or `feedback:ok`
4. Store feedback in DynamoDB: `pk: FEEDBACK#{userId}`, `sk: {ISO timestamp}`, `rating: good|ok`
5. Reply "謝謝你的回饋 🙏"

## DynamoDB Schema Addition

Feedback items stored in the existing `prajna-gate-conversations` table:

| Attribute | Type | Description |
|-----------|------|-------------|
| pk | S | `FEEDBACK#{userId}` |
| sk | S | ISO timestamp |
| rating | S | `good` or `ok` |
| ttl | N | 90 days from creation |

## File Changes

### Modified files:
- `lambda/index.mjs` — Add routing for `@` commands and postback events
- `lambda/services/memory.mjs` — Add `clearMemory(userId)` function
- `lambda/line.mjs` — Add `replyWithQuickReply(replyToken, text, items)` function

### New files:
- `lambda/commands.mjs` — Command handlers (隨意聊聊, 重新開始, 回饋, postback handling)
- `scripts/setup-richmenu.mjs` — One-time script to create Rich Menu via LINE API, generate image, upload, and set as default

## Rich Menu Setup Script

`scripts/setup-richmenu.mjs` will:
1. Create a Rich Menu object via LINE API (`POST /v2/bot/richmenu`)
2. Generate a 2500x843 image with three labeled sections using canvas
3. Upload the image to the Rich Menu (`POST /v2/bot/richmenu/{richMenuId}/content`)
4. Set it as the default Rich Menu (`POST /v2/bot/user/all/richmenu/{richMenuId}`)

Run once: `node scripts/setup-richmenu.mjs`

## Non-Goals

- Rich Menu per-user customization
- Analytics dashboard for feedback data
- Multi-language support
