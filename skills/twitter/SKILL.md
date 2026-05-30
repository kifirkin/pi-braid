---
name: twitter
description: "Post replies and check bot responses on X via browser automation."
---

# Twitter Interaction Skill

You are an agent working through a browser. You navigate to tweet pages, fill reply forms, and verify the bot responded.

## Config Variables

Replace before any tool call:

```
MY_HANDLE     = your Twitter handle (without @)
TARGET_BOT    = @bot_handle
TARGET_HANDLE = bot_handle (without @)
```

## DOM Reference

| Element            | Selector                            | Notes                                                |
| ------------------ | ----------------------------------- | ---------------------------------------------------- |
| Tweet article      | `article[data-testid="tweet"]`      | Same for your tweets and bot replies                 |
| Tweet text         | `[data-testid="tweetText"]`         | Inside each article                                  |
| Author name        | `[data-testid="User-Name"]`         | Check for `@TARGET_BOT` or `@MY_HANDLE`              |

---

## Flow 1: Post a Reply

### RELIABLE METHOD: Intent/Post URL with Text Prefill

```
https://x.com/intent/post?text=URL_ENCODED_TEXT&in_reply_to=TARGET_TWEET_ID
```

1. **Navigate** to intent URL (with text + `in_reply_to` if replying, without `in_reply_to` if standalone).
   - Always include `@TARGET_BOT` in the text — the `in_reply_to` param alone does NOT trigger the bot's mention scanner.
2. **Wait 3-5s** for Draft.js to hydrate the text from the URL params.
3. **Verify text prefilled** — the compose form is a DIALOG overlay on the main feed. Check inside `[role="dialog"]`:
   ```js
   const dialogs = document.querySelectorAll('[role="dialog"]');
   let text = '';
   for (let d of dialogs) {
     let el = d.querySelector('div[contenteditable="true"][role="textbox"]');
     if (el?.innerText?.trim()) { text = el.innerText.trim(); break; }
   }
   text || '(empty — wait or retry)';
   ```
4. **Post** — button is inside the dialog. Check it's enabled, then click:
   ```js
   const dialog = document.querySelectorAll('[role="dialog"]')[0];
   const btn = dialog?.querySelector('[data-testid="tweetButton"]');
   if (btn && !btn.hasAttribute('aria-disabled')) {
     btn.click();
     'posted';
   }
   ```
5. **Verify** — URL should change to `x.com/home`. Then search.

### How X's Post Button Works
- Uses `aria-disabled="true"` (not `.disabled`).
- Button is **only enabled when text is present**. If disabled, the text hasn't hydrated yet or didn't prefill.
- **🚫 NEVER force-click** — removing `aria-disabled` and clicking navigates to /home WITHOUT submitting. The tweet never posts.
- If button stays disabled: wait longer for Draft.js hydration, or re-navigate with a simpler URL (shorter text, no `in_reply_to`).

### Known Issue
Intent URL sometimes fails to prefill text (especially with `in_reply_to`). **Fix**: Post as standalone (omit `in_reply_to`) — bot still picks up the @mention from mention scan.

---

## Flow 2: Check for Bot Reply

Search with live sorting. Never use the bot's profile page (`/with_replies`) — content is truncated.

**Search query** (captures both reply chains and standalone mentions):
```
(from:MY_HANDLE TARGET_BOT) OR (from:TARGET_BOT to:MY_HANDLE)
```

1. Navigate to `https://x.com/search?q=(from%3AMY_HANDLE%20TARGET_HANDLE)%20OR%20(from%3ATARGET_HANDLE%20to%3AMY_HANDLE)&f=live`
2. Wait 3-4s for results to load.
3. Read visible text with `browser_content()`.
4. In case of search lag (~30-60s), wait and retry.

### Scan Bot's Recent Activity (All Users)
Navigate to `https://x.com/search?q=from%3ATARGET_HANDLE&f=live` and use `browser_content()` to extract visible text. Shows ALL bot replies to every user.

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| No compose dialog appears | Page not loaded, or used `/compose/post` | Navigate to `x.com/intent/post?text=...` instead |
| Text not prefilled after navigation | Draft.js didn't hydrate, or intent URL glitched | Wait 3-5s and check inside `[role="dialog"]`. Retry with simpler URL |
| Button disabled even though text is visible | Draft.js hydrating text but React state not ready | Wait 3-5s more. If still disabled, re-navigate |
| about:blank page | Harness reload or used `/with_replies` | Re-navigate to search or intent URL |
| Reply not appearing in search | Search lag (~30-60s) | Wait 30s, retry |
| X lazy-loads content | Scroll not triggered | Use `browser_content()` to extract all visible text |
