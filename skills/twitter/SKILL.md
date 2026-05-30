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

### Fallback: Inline Reply on Tweet Page
When intent/post URL fails to prefill, navigate to the bot's tweet page and reply inline:
```
https://x.com/TARGET_HANDLE/status/TWEET_ID
```
1. Wait for page to load, click reply button: `[data-testid="reply"]`
2. Wait 2s for the inline compose to appear
3. Focus the Draft.js editor and insert text:
   ```js
   let compose = document.querySelector('div[contenteditable="true"][role="textbox"]');
   if (compose) {
     compose.focus();
     document.execCommand('insertText', false, '@TARGET_BOT your text here');
   }
   ```
4. Click Reply: `[data-testid="tweetButtonInline"]`

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

## Image Attachment

### Method 1: Drag-and-Drop (Most Reliable)
Generate image and dispatch a drop event on the compose area:

```js
// Generate canvas, convert to File, dispatch drop
const blob = await new Promise(resolve => cv.toBlob(resolve, 'image/png'));
const file = new File([blob], 'image.png', { type: 'image/png' });
const dt = new DataTransfer();
dt.items.add(file);
const ta = document.querySelector('[data-testid="tweetTextarea_0"]');
const dropZone = ta.closest('[data-testid*="tweet"]') || ta.parentElement;
dropZone.dispatchEvent(new DragEvent('drop', {
  dataTransfer: dt, bubbles: true, cancelable: true
}));
```

### Method 2: CDP File Injection (Best for Automation)
Uses `browser_upload_image` tool — injects files at the CDP protocol level, no clipboard/React state issues:

```js
browser_upload_image(
  filePath="/path/to/image.png",
  clickBtn="[aria-label='Add photos or video']"
)
```

### Method 3: Clipboard Paste
Requires clipboard permission once per session:

```js
await navigator.clipboard.write([
  new ClipboardItem({ 'image/png': blob })
]);
const ta = document.querySelector('[data-testid="tweetTextarea_0"]');
ta.focus();
ta.dispatchEvent(new ClipboardEvent('paste', {
  clipboardData: dt, bubbles: true, cancelable: true
}));
```

### Verification
```js
const previews = document.querySelectorAll('img[src*="blob:"]');
const attachments = document.querySelectorAll('[data-testid*="attachment"]');
// Should be ≥ 1 each
```

Note: Bot vision is unreliable. Text-only engagement works as well.

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| No compose dialog appears | Page not loaded, or used `/compose/post` | Navigate to `x.com/intent/post?text=...` instead |
| Text not prefilled after navigation | Draft.js didn't hydrate, or intent URL glitched | Wait 3-5s and check inside `[role="dialog"]`. Retry with simpler URL |
| Button disabled even though text is visible | Draft.js hydrating text but React state not ready | Wait 3-5s more. If still disabled, re-navigate |
| about:blank page | Harness reload or used `/with_replies` | Re-navigate to search or intent URL |
| Reply not appearing in search | Search lag (~30-60s) | Wait 30s, retry |
| X lazy-loads content | Scroll not triggered | Use `browser_content()` to extract all visible text |
