---
name: twitter
description: "Post replies and check bot responses on X via browser automation. You read pages, fill forms, verify outcomes."
---

# Twitter Interaction Skill

You are an agent working through a browser. You navigate to tweet pages, fill reply forms, and verify the bot responded. The mechanics are straightforward — the page layout is consistent, the DOM selectors stable.

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
| Inline reply form  | `[data-testid="tweetTextarea_0"]`   | Already on bot's tweet page — no need to click reply |
| Reply button       | `[data-testid="tweetButtonInline"]` | Text reads "Reply"                                   |
| Reply icon (count) | `[data-testid="reply"]`             | `aria-label` e.g. "1 Reply. Reply"                   |
| File input          | `input[type="file"]`                | Hidden by default, triggered by add-media button      |
| Add media button    | `[aria-label="Add photos or video"]` | Click to expose file input                            |

## Image Attachment

### Method 1: Drag-and-Drop (Most Reliable)
X's compose box supports drag-and-drop for images. No permission required.

```js
// Step 1: Generate the canvas image
const cv = document.createElement('canvas');
const gx = cv.getContext('2d');
// ... draw content ...

// Step 2: Convert to blob, then File
const blob = await new Promise(resolve => cv.toBlob(resolve, 'image/png'));
const file = new File([blob], 'image.png', { type: 'image/png' });

// Step 3: Dispatch drop event
const dt = new DataTransfer();
dt.items.add(file);
const ta = document.querySelector('[data-testid="tweetTextarea_0"]');
const dropZone = ta.closest('[data-testid*="tweet"]') || ta.parentElement;
dropZone.dispatchEvent(new DragEvent('drop', {
  dataTransfer: dt, bubbles: true, cancelable: true
}));
```

### Method 2: Clipboard Paste
Chrome asks for clipboard permission once per session.

```js
await navigator.clipboard.write([
  new ClipboardItem({ 'image/png': blob })
]);
const ta = document.querySelector('[data-testid="tweetTextarea_0"]');
ta.focus();
const dt = new DataTransfer();
dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
ta.dispatchEvent(new ClipboardEvent('paste', {
  clipboardData: dt, bubbles: true, cancelable: true
}));
```

### Method 3: CDP File Injection (Best for Automation)
Uses `browser_upload_image` tool which injects files via CDP's `DOM.setFileInputFiles` at the protocol level. No clipboard, no React state issues.

```js
// In pi agent:
browser_upload_image(
  filePath="/path/to/image.png",
  clickBtn="[aria-label='Add photos or video']"
)
```

### Verification Checklist (Before Adding Text)
```js
const previews = document.querySelectorAll('img[src*="blob:"]');
const attachments = document.querySelectorAll('[data-testid*="attachment"]');
// Must be ≥ 1 each before proceeding
console.log('previews:', previews.length, 'attachments:', attachments.length);
```

### Common Pitfalls
| Problem | Fix |
|---------|-----|
| Clipboard denied | Use drag-and-drop instead (no permission)
| Previews visible but no image in post | React state sync issue — drag-and-drop works better than clipboard
| Blurry/pixelated image | Canvas-to-clipboard loses quality. Save as file and use CDP injection instead
| Button disabled after text insert | execCommand sometimes fails to trigger React — clear and retry with shorter text
| Text appears empty after intent navigation **(NEW)** | Draft.js needs 3-5s to hydrate. Don't check immediately. Or fall back to standalone URL (omit `in_reply_to`).

## Button State

X uses `aria-disabled="true"`, not `.disabled`:

```js
// Check if enabled:
btn.hasAttribute("aria-disabled"); // true = disabled, false = enabled

// Click if enabled:
if (btn && !btn.hasAttribute("aria-disabled")) {
  btn.click();
}
```

### 🚫 CRITICAL: Never Force-Click
Do NOT remove `aria-disabled` and click. This was a persistent wrong assumption. Force-clicking navigates to /home without actually submitting — the tweet never posts. If the button is disabled:
- Wait 3-5s more for Draft.js to hydrate
- Check if text is actually present
- If text is set and button stays disabled, re-navigate with a simpler URL
- Never: `btn.removeAttribute('aria-disabled'); btn.click();`

---

## Flow 1: Post a Reply (Method A — Intended Reply)

### Preferred: Intent/Post URL with Text Prefill

```
https://x.com/intent/post?text=URL_ENCODED_TEXT&in_reply_to=TARGET_TWEET_ID
```

1. **Navigate** to intent URL with text AND `in_reply_to=TWEET_ID`.
2. **Wait 3-5s** — Draft.js editor needs time to hydrate after navigation. Checking too early returns empty even though text is prefilled.
3. **Verify text prefilled** — check the only contenteditable div with role="textbox". Use innerText (NOT `[data-text]` attr — that doesn't exist on Draft.js):
   ```js
   const compose = document.querySelector('div[contenteditable="true"][role="textbox"]');
   compose?.innerText?.trim() || '(empty — wait longer or text failed to prefill)';
   ```
   If empty: the page may still be loading, or the intent URL failed. Re-navigate with a simpler URL (shorter text, no in_reply_to).
4. **Check button state** — X uses `aria-disabled="true"`, not `.disabled`. Button should be enabled if text is present:
   ```js
   const btn = document.querySelector('[data-testid="tweetButton"]');
   btn?.hasAttribute('aria-disabled'); // false = enabled
   btn?.click();
   ```
5. **Verify post** — URL should change to `x.com/home`. Then search: `(from:MY_HANDLE TARGET) OR (from:TARGET to:MY_HANDLE)`.

### CRITICAL: Never Force-Click
Force-removing `aria-disabled` and clicking never actually posts — it navigates to /home without submitting. If the button is disabled, the text didn't prefill correctly. Fix the text prefill, don't force the click an intent/post URL, the Draft.js editor takes 1-3 seconds to hydrate the text from the URL parameters. If you check for text too early, it appears empty. Always wait 3-5 seconds before verifying. The button will also remain disabled until text is present, so timing is critical for both verification and posting.

### CRITICAL: Always Include @mention in Reply Text
```
// DO THIS — include @handle even when in_reply_to is set:
https://x.com/intent/post?text=%40TARGET_BOT%20YOUR%20TEXT&in_reply_to=TWEET_ID

// NOT THIS — in_reply_to alone is unreliable:
https://x.com/intent/post?text=YOUR%20TEXT&in_reply_to=TWEET_ID
```
**Evidence**: A reply posted with `in_reply_to` but WITHOUT `@TARGET_BOT` in text got 0 bot replies. Same text reposted WITH the @ mention got a reply. The `in_reply_to` param does NOT reliably trigger the bot's mention scanner. Always include the @ in the text.

### Known Issue: intent/post May Fail to Prefill Text
X's intent URL sometimes fails to prefill text when `in_reply_to` is set, even with short URLs. Symptoms: compose opens empty or only `@handle` shows. **Fix**: Post as standalone (omit `in_reply_to`) — bot still picks up @mention from mention scan. If reply threading is critical, use inline reply method instead.

### Fallback: Inline Reply on Tweet Page
Navigate to bot's tweet page, click Reply by `[aria-label="0 Replies. Reply"]`, type via Draft.js content injection, click `[data-testid="tweetButtonInline"]`.

---

## Flow 2: Check for Bot Reply

Only method: search with live sorting. Never use the bot's profile page (`/with_replies`) — it's unreliable, content is truncated.

### Key Insight: Bidirectional + Standalone Mentions
`from:MY_HANDLE to:TARGET_BOT` only shows YOUR direct reply tweets (sent TO the bot). Standalone mentions (tweets with @handle in body, not in reply to) are NOT captured by `to:`. Use:

> `(from:MY_HANDLE TARGET_BOT) OR (from:TARGET_BOT to:MY_HANDLE)`

### @mention Required Even in Replies
A reply posted via `in_reply_to=ID` WITHOUT `@TARGET_BOT` in text was never replied to. Same text reposted WITH `@TARGET_BOT` got a reply. Always include @handle in the body even when `in_reply_to` is set.

1. **Check count + read replies** — navigate to `https://x.com/search?q=(from%3AMY_HANDLE%20to%3ATARGET_HANDLE)%20OR%20(from%3ATARGET_HANDLE%20to%3AMY_HANDLE)&f=live`. Wait 4s. Then scan ALL articles for both your tweets and the bot's replies:

   ```js
   const arts = document.querySelectorAll('article[data-testid="tweet"]');
   for (const a of arts) {
     const author = a.querySelector('[data-testid="User-Name"]')?.textContent || '';
     const txt = a.querySelector('[data-testid="tweetText"]')?.textContent || '';
     if (author.includes('TARGET_BOT')) {
       botReplies.push(txt.trim());
     }
   }
   ```

2. **Full page text** — if DOM parsing is incomplete, use `browser_content()` to read all visible text. The search page renders both directions in chronological order.

3. **Classify** — template or custom? (see AGENTS.md for response patterns)

### To Scan Bot's Recent Activity (All Users)
Navigate to `https://x.com/search?q=from%3ATARGET_HANDLE&f=live` and scroll to load more. Use `browser_content()` to extract all visible text. This shows ALL of the bot's recent replies to every user — useful for tracking other researchers' progress and bot behavior patterns.

---

## Troubleshooting

| Problem                       | Likely Cause                                 | Fix                                                 |
| ----------------------------- | -------------------------------------------- | --------------------------------------------------- |
| No textarea                   | Wrong page / not loaded / used /compose/post | Navigate to bot's tweet page, not compose. Wait 4s. |
| about:blank                   | Harness reload or used /with_replies         | Re-navigate to bot's tweet page or search           |
| Button disabled after fill    | React/Draft.js desync                        | Force-enable (safe — see Button State above)        |
| All steps in one eval call    | React never processed state                  | Split into separate eval calls                      |
| Reply count 0 but bot replied | Search lag (~30-60s)                         | Wait 30s, retry                                     |
| X lazy-loads content          | Scroll not triggered                         | Use `browser_content()` to extract all visible text |
