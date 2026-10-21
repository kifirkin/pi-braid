---
name: twitter
description: "Post replies and check bot responses on X via browser automation."
status: deprecated
successor: none (owner decision pending)
validated: 2026-08-16
verdict: DEPRECATE
---

> **DEPRECATED (2026-08-16)** - platform-specific flavor with a single recorded use (vibe-hacking-a0). No successor skill exists; the browser-automation techniques below remain valid reference for any X workflow.
>
> Reading a public post needs no browser and no login - the `research` skill carries the oEmbed method (publish.x.com/oembed), which returns the post text as JSON.

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

| Element       | Selector                       | Notes                                   |
| ------------- | ------------------------------ | --------------------------------------- |
| Tweet article | `article[data-testid="tweet"]` | Same for your tweets and bot replies    |
| Tweet text    | `[data-testid="tweetText"]`    | Inside each article                     |
| Author name   | `[data-testid="User-Name"]`    | Check for `@TARGET_BOT` or `@MY_HANDLE` |

---

## Flow 1: Post a Reply

### RELIABLE METHOD: Intent/Post URL with Text Prefill

```
https://x.com/intent/post?text=URL_ENCODED_TEXT&in_reply_to=TARGET_TWEET_ID
```

1. **Navigate** to intent URL (with text + `in_reply_to` if replying, without `in_reply_to` if standalone).
   - Always include `@TARGET_BOT` in the text - the `in_reply_to` param alone does NOT trigger the bot's mention scanner.
2. **Wait 3-5s** for Draft.js to hydrate the text from the URL params.
3. **Verify text prefilled** - the compose form is a DIALOG overlay on the main feed. Check inside `[role="dialog"]`:
   ```js
   const dialogs = document.querySelectorAll('[role="dialog"]');
   let text = "";
   for (let d of dialogs) {
     let el = d.querySelector('div[contenteditable="true"][role="textbox"]');
     if (el?.innerText?.trim()) {
       text = el.innerText.trim();
       break;
     }
   }
   text || "(empty — wait or retry)";
   ```
4. **Post** - button is inside the dialog. Check it's enabled, then click:
   ```js
   const dialog = document.querySelectorAll('[role="dialog"]')[0];
   const btn = dialog?.querySelector('[data-testid="tweetButton"]');
   if (btn && !btn.hasAttribute("aria-disabled")) {
     btn.click();
     ("posted");
   }
   ```
5. **Verify post success** - URL → /home is necessary but NOT sufficient. After 5+ seconds, navigate to `https://x.com/MY_HANDLE` (profile) or `https://x.com/search?q=from%3AMY_HANDLE%20TARGET_HANDLE&f=live` and confirm with `browser_content()` that the tweet actually appears. If it doesn't, the post failed silently - investigate before retrying (see Verification Discipline below).

### How X's Post Button Works

- Uses `aria-disabled="true"` (not `.disabled`).
- Button is **only enabled when text is present**. If disabled, the text hasn't hydrated yet or didn't prefill.
- **🚫 NEVER force-click** - removing `aria-disabled` and clicking navigates to /home WITHOUT submitting. The tweet never posts.
- If button stays disabled: wait longer for Draft.js hydration, or re-navigate with a simpler URL (shorter text, no `in_reply_to`).

### Known Issues

1. **Silent hydration failure**: Intent URL sometimes fails to prefill text (especially with `in_reply_to`). **Fix**: Post as standalone (omit `in_reply_to`) - bot still picks up the @mention from mention scan.

2. **Wrong compose context - `/compose/post` redirect**: After clicking reply button on a tweet page, the URL may silently redirect to `x.com/compose/post` (standalone compose) instead of showing an inline dialog. This happens when X navigates to compose as a separate page rather than a modal. **Sign**: URL becomes `https://x.com/compose/post` instead of `https://x.com/TARGET_HANDLE/status/TWEET_ID`. **Fix**: Re-navigate to the tweet page (`browser_navigate`) and wait for full page load before clicking reply.

3. **Post button clicks but compose doesn't close**: When this happens, `browser_eval` returns `'posted'` but the tweet was not submitted. **Fix**: Always verify post success - navigate to search after posting and confirm the tweet appears.

4. **Redirect after successful post**: After intent/post URL post submission, X redirects to `/home`. This is NOT proof of success - the button click can register without the post being published. Always verify in search/profile.

5. **`/compose/post` trap after posting**: After a successful intent URL post (which redirects to /home), navigating to a tweet page and clicking the inline reply button triggers X to open `x.com/compose/post` (standalone blank compose) instead of an inline dialog. This is because X treats the navigation from /home as a fresh page context where inline modals fail. **Fix**: Always use intent URL for replies, never inline reply after a post. If inline is needed, navigate to the tweet page FIRST (before any post), click reply there.

6. **Inline reply button targets parent thread tweet**: On a tweet permalink page, `[data-testid="reply"]` buttons may target the thread parent instead of the specific tweet. **Fix**: Navigate to the tweet by ID, wait for full load, then use `browser_eval` to locate the reply button near the correct article by checking text content of the article before clicking.

7. **Draft.js empty compose on unfocused tab**: Intent URL dialog renders but `contenteditable` has no text. Draft.js defers hydration when the browser tab is not focused. **Fix**: Call `window.focus()` before checking compose state, or send a click to the dialog area first.

8. **`in_reply_to` is cosmetic for X UI threading, not functional for bot detection**: The bot scans all @mentions globally. A tweet with an invalid `in_reply_to` still reaches the bot, but X displays it as a standalone profile tweet instead of a threaded reply. This causes "profile appearance" issues where replies show on your profile feed. **Fix**: Always verify `in_reply_to` points to the correct target tweet ID. If threading breaks, the bot still received and replied - just the X UI chain is broken.

### Fallback: Inline Reply on Tweet Page

When intent/post URL fails to prefill, navigate to the bot's tweet page and reply inline:

```
https://x.com/TARGET_HANDLE/status/TWEET_ID
```

1. Wait for page to load, click reply button: `[data-testid="reply"]`
2. Wait 2s for the inline compose to appear
3. Focus the Draft.js editor and insert text:
   ```js
   let compose = document.querySelector(
     'div[contenteditable="true"][role="textbox"]',
   );
   if (compose) {
     compose.focus();
     document.execCommand("insertText", false, "@TARGET_BOT your text here");
   }
   ```
4. Click Reply: `[data-testid="tweetButtonInline"]`

### Critical: Targeting the Correct Reply

On a tweet permalink page, multiple `[data-testid="reply"]` buttons exist (one per tweet in the thread). Clicking the wrong one opens compose in `/compose/post` context (standalone, no reply target). **Always verify**:

```js
// Check if compose is on the right page
const url = window.location.href;
if (url.includes("compose/post")) {
  // Wrong context — re-navigate to tweet page
  return "WRONG_CONTEXT — re-navigate";
}

// For permalink pages, find the specific tweet's reply button:
const articles = document.querySelectorAll('article[data-testid="tweet"]');
let targetBtn = null;
for (let a of articles) {
  const text = a.querySelector('[data-testid="tweetText"]')?.innerText;
  if (text?.includes("UNIQUE_KEYWORD_FROM_BOT_TWEET")) {
    targetBtn = a.querySelector('[data-testid="reply"]');
    break;
  }
}
if (targetBtn) targetBtn.click();
```

**If URL becomes `x.com/compose/post`** after clicking reply: the click targeted the wrong thread context. Re-navigate to the tweet page and retry with more specific targeting.

---

## Flow 2: Check for Bot Reply

Search with live sorting. Never use the bot's profile page (`/with_replies`) - content is truncated.

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
const blob = await new Promise((resolve) => cv.toBlob(resolve, "image/png"));
const file = new File([blob], "image.png", { type: "image/png" });
const dt = new DataTransfer();
dt.items.add(file);
const ta = document.querySelector('[data-testid="tweetTextarea_0"]');
const dropZone = ta.closest('[data-testid*="tweet"]') || ta.parentElement;
dropZone.dispatchEvent(
  new DragEvent("drop", {
    dataTransfer: dt,
    bubbles: true,
    cancelable: true,
  }),
);
```

### Method 2: CDP File Injection (Best for Automation)

Uses `browser_upload_image` tool - injects files at the CDP protocol level, no clipboard/React state issues:

```js
browser_upload_image(
  (filePath = "/path/to/image.png"),
  (clickBtn = "[aria-label='Add photos or video']"),
);
```

### Method 3: Clipboard Paste

Requires clipboard permission once per session:

```js
await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
const ta = document.querySelector('[data-testid="tweetTextarea_0"]');
ta.focus();
ta.dispatchEvent(
  new ClipboardEvent("paste", {
    clipboardData: dt,
    bubbles: true,
    cancelable: true,
  }),
);
```

### Verification

```js
// CORRECT (filter by blob: prefix in dialog):
let allImgs = Array.from(document.querySelectorAll('[role="dialog"] img'));
let blobImages = allImgs.filter((img) => img.src?.startsWith("blob:"));
let hasAttachment = blobImages.length > 0;
```

Note: Bot vision is unreliable. Text-only engagement works as well.

## Verification Discipline (CRITICAL)

These rules prevent hallucination spirals. They were learned the hard way - when a phantom bot reply was treated as authoritative input and an entire narrative was built on data that never existed. Any reply that lands while the previous one is still being verified should be flagged as suspect, not as input.

### Rule 1: Tweet text: use `browser_content()`, never `browser_eval()`

`browser_eval` can return stale page data, partial renders, or content that doesn't actually exist on the page (e.g., concatenated like counts, last-cached DOM, or even text from a different page if navigation didn't complete). For ANY text extraction from a tweet:

- ✅ `browser_content()` - extracts rendered DOM text reliably
- ❌ `browser_eval` reading `article[data-testid="tweet"]` - unreliable, can hallucinate

Cross-check at least one bot reply per session using `browser_content`. If your parsed text doesn't match what `browser_content` shows, your parser is wrong - don't trust the eval.

### Rule 2: Post success: verify in profile, not URL change

URL → /home is necessary but NOT sufficient. The button click can register without the post being published. After every post:

1. Wait 5+ seconds
2. Navigate to `https://x.com/MY_HANDLE` (profile) or `https://x.com/search?q=from%3AMY_HANDLE%20TARGET_HANDLE&f=live`
3. Use `browser_content()` to verify the tweet actually appears in the result
4. If it doesn't appear, the post failed silently - investigate before retrying

### Rule 3: Simulate 2-3 turns before posting

Before clicking post on a real probe, draft the bot's likely reply 2-3 turns forward. If your arc relies on a bot reply that hasn't actually happened yet, STOP. Verify first, post second. Hot bot replies trigger the urge to keep the streak going - that urge is exactly when phantom-data errors slip in.

### Rule 4: Trust user pushback

If your interpretation of a bot reply seems too tidy - "MAJOR HINT", "BREAKTHROUGH", "the bot finally let something slip" - re-read the actual text with `browser_content`. The cleaner the story, the more likely you're filling gaps with narrative.

### Common silent failures

| Symptom                                              | Likely cause                                  | Fix                                                                    |
| ---------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| URL → /home but post not in profile                  | Rate limit, account flag, compose state issue | Wait 5+ min, check rate limit, retry with simpler text                 |
| Compose clears but post not in search                | Draft mode, not publish                       | Check whether "Post" or "Save draft" was clicked                       |
| Reply button click "succeeds" but bot never sees it  | Wrong reply target, parent tweet not loaded   | Verify parent tweet ID, wait for page load before clicking             |
| `browser_eval` returns text not in `browser_content` | Eval ran on stale/cached page state           | Re-navigate, wait longer, switch to `browser_content`                  |
| Inline reply button stays disabled                   | Bot's tweet thread not fully loaded           | Wait 5+s for thread, then click reply; if still disabled, refresh page |

## Troubleshooting

| Problem                                     | Cause                                             | Fix                                                                  |
| ------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------- |
| No compose dialog appears                   | Page not loaded, or used `/compose/post`          | Navigate to `x.com/intent/post?text=...` instead                     |
| Text not prefilled after navigation         | Draft.js didn't hydrate, or intent URL glitched   | Wait 3-5s and check inside `[role="dialog"]`. Retry with simpler URL |
| Button disabled even though text is visible | Draft.js hydrating text but React state not ready | Wait 3-5s more. If still disabled, re-navigate                       |
| about:blank page                            | Harness reload or used `/with_replies`            | Re-navigate to search or intent URL                                  |
| Reply not appearing in search               | Search lag (~30-60s)                              | Wait 30s, retry                                                      |
| X lazy-loads content                        | Scroll not triggered                              | Use `browser_content()` to extract all visible text                  |

## Lessons Learned

### Posting Mechanics

- Intent/post URL with text prefill works - wait 3-5s for Draft.js hydration
- Always scope DOM to `[role="dialog"]` - compose is a modal overlay
- NEVER force-click `tweetButton` - navigates to /home without submitting <!-- doc-ref-exempt: DOM selector in the browser recipe -->
- Button check: `aria-disabled="true"` = disabled, becomes enabled after text hydrates
- 280 char hard limit - verify with `compose.innerText?.trim()?.length` before posting
- If `in_reply_to` breaks prefill - omit it and post standalone
- Use `browser_upload_image` with `clickBtn` - attaches via CDP, bypasses React state <!-- doc-ref-exempt: host tool name and DOM selector in the browser recipe -->

### Image Attachment Detection

- Filter for `img[src^="blob:"]` to find uploaded attachments (NOT total img count)
- Profile pic is NOT an attachment - an `img` with `alt` matching your display name and a `pbs.twimg.com` src
- Stickers/emoji are NOT attachments - `img[alt=""]` with `pbs.twimg.com` src
- Selectors that DO NOT work: `[data-testid="tweetPhoto"]`, `[data-testid="mediaAttachment"]`, `[data-testid="mediaPreview"]`
- Correct detection:
  ```js
  let allImgs = Array.from(document.querySelectorAll('[role="dialog"] img'));
  let blobImages = allImgs.filter((img) => img.src?.startsWith("blob:"));
  let hasAttachment = blobImages.length > 0;
  ```

### Engagement Patterns

- Always include `@TARGET_BOT` in tweet text even when `in_reply_to` param is set - mention scanners look at body text, not just thread context
- Set reply-check timers for 3+ minutes (shorter intervals can miss bot load lag)
- Fall back to manual `browser_navigate` + `browser_content` checks if timers are unreliable
