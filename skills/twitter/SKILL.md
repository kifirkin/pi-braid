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

## Button State

X uses `aria-disabled="true"`, not `.disabled`:

```js
// Check if enabled:
btn.hasAttribute("aria-disabled"); // true = disabled

// Force-enable on desync (safe, React desync is the real cause):
btn.removeAttribute("aria-disabled");
btn.click();
```

---

## Flow 1: Post a Reply

Only method: inline reply form on the bot's tweet page. Never use `/compose/post` or `x.com/hackingA0/with_replies`.

1. **Navigate** → `x.com/TARGET_HANDLE/status/BOT_TWEET_ID`. Wait 4s.
   - The inline reply form is already on the page. Do not click any reply button.
   - Never use `x.com/YOUR_HANDLE/status/ID` — innerHTML doesn't trigger Draft.js there.
   - Never use `/compose/post` for fresh tweets — only reply to the bot's existing tweet via inline form.

2. **Fill** — one `browser_eval` call:

   ```js
   const ta = document.querySelector('[data-testid="tweetTextarea_0"]');
   if (!ta) "no textarea";
   ta.focus();
   const spans = ta.querySelectorAll("span[data-offset-key]");
   if (spans.length > 0) spans[0].innerHTML = "YOUR REPLY TEXT";
   ta.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
   ```

   Wait 1s.

3. **Sync** — separate `browser_eval`:

   ```js
   document.execCommand("selectAll");
   document.execCommand("delete");
   document.execCommand("insertText", false, "YOUR REPLY TEXT");
   ```

   Wait 1s.

4. **Post** — separate `browser_eval`:

   ```js
   const btn = document.querySelector('[data-testid="tweetButtonInline"]');
   if (btn && !btn.hasAttribute("aria-disabled")) btn.click();
   else {
     btn.removeAttribute("aria-disabled");
     btn.click();
   }
   ```

   Wait 2s.

5. **Verify** — check the new tweet appears in the timeline. Each step in a separate call — React needs the event loop.

---

## Flow 2: Check for Bot Reply

Only method: search with live sorting. Never use the bot's profile page (`/with_replies`) — it's unreliable, content is truncated.

1. **Check count** — navigate to `https://x.com/search?q=from%3AMY_HANDLE%20to%3ATARGET_HANDLE&f=live`. Wait 4s. Query the first article's reply button:

   ```js
   const arts = document.querySelectorAll('article[data-testid="tweet"]');
   const replyBtn = arts[0]?.querySelector('[data-testid="reply"]');
   replyBtn?.getAttribute("aria-label"); // "1 Reply" means bot replied
   ```

   Count 0 → bot hasn't replied yet. Set a timer (bot responds in 1-5 min). Count >0 → proceed.

2. **Read reply** — use the SAME search page. The bot's replies appear as separate articles in the search results. Scan all articles for the bot's:

   ```js
   const arts = document.querySelectorAll('article[data-testid="tweet"]');
   for (const a of arts) {
     const author = a.querySelector('[data-testid="User-Name"]');
     const txt = a.querySelector('[data-testid="tweetText"]');
     if (author?.textContent.includes("TARGET_BOT")) botReplies.push(txt.textContent.trim());
   }
   ```

   If the bot's reply isn't visible among the first N articles, use `browser_content()` to read the full page text instead — search renders all matching tweets.

3. **Classify** — template or custom? (see AGENTS.md for response patterns)

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
