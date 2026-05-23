---
name: twitter
description: "Post tweets, check replies, and interact with Twitter/X bots via browser automation. Single clean flow with no contradictions."
---

# Twitter Interaction Skill

## Config Variables

Replace these before any tool call:
```
MY_HANDLE     = your Twitter handle (without @)
TARGET_BOT    = @bot_handle  (with @)
TARGET_HANDLE = bot_handle   (without @)
```

## Key DOM Selectors

| Element | Selector | Notes |
|---------|----------|-------|
| Tweet article | `article[data-testid="tweet"]` | Both your tweets and bot replies have this |
| Tweet text | `[data-testid="tweetText"]` | Inside each article |
| Author name | `[data-testid="User-Name"]` | Check for `@TARGET_BOT` or `@MY_HANDLE` |
| Inline reply form | `[data-testid="tweetTextarea_0"]` | Already present on bot's tweet page |
| Reply button | `[data-testid="tweetButtonInline"]` | Text shows "Reply" |
| Compose button | `[data-testid="tweetButton"]` | Text shows "Post" |
| Reply icon (count) | `[data-testid="reply"]` | aria-label shows count e.g. "1 Reply. Reply" |
| Countdown circle | `[data-testid="countdown-circle"]` | Shows remaining/over-limit chars |

## Button State Check

X uses `aria-disabled="true"`, NOT `.disabled`. Always use:
```javascript
btn.hasAttribute('aria-disabled')  // true = disabled, false = enabled
```
Force-enable is safe (React desync is the real cause, not rate limiting):
```javascript
btn.removeAttribute('aria-disabled');
btn.click();
```

---

## Flow 1: Compose and Post a Reply

Navigate to the bot's tweet page, fill the inline form, post, verify.

```
1. NAVIGATE → x.com/TARGET_HANDLE/status/BOT_TWEET_ID
   Wait 4s for page to load
   (DO NOT click the reply button — inline form is already on page)

2. FILL → browser_eval: fill textarea via innerHTML + InputEvent
   Wait 1s

3. SYNC → browser_eval: execCommand selectAll → delete → insertText
   Wait 1s

4. POST → browser_eval: check btn, click if enabled (or force-enable)
   Wait 2s

5. VERIFY → browser_eval: check if tweet appears as new article
```

### Step-by-step JS

**Step 2 — Fill the textarea:**
```javascript
// Fill the inline reply form
const textarea = document.querySelector('[data-testid="tweetTextarea_0"]');
if (!textarea) return 'no textarea';  // page not loaded or wrong page
textarea.focus();
const spans = textarea.querySelectorAll('span[data-offset-key]');
if (spans.length > 0) spans[0].innerHTML = 'YOUR TWEET TEXT';
textarea.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
```

**Step 3 — Sync with React/Draft.js:**
```javascript
document.execCommand('selectAll');
document.execCommand('delete');
document.execCommand('insertText', false, 'YOUR TWEET TEXT');
```

**Step 4 — Post:**
```javascript
const btn = document.querySelector('[data-testid="tweetButtonInline"]');
if (btn && !btn.hasAttribute('aria-disabled')) {
  btn.click();
}
// If disabled → force-enable (safe):
btn.removeAttribute('aria-disabled');
btn.click();
```

**Step 5 — Verify:**
```javascript
Array.from(document.querySelectorAll('article[data-testid="tweet"]'))
  .some(a => a.querySelector('[data-testid="tweetText"]')
  ?.textContent?.includes('YOUR UNIQUE TEXT'));
```

### Critical Rules

1. **Each step in SEPARATE browser_eval call** — React needs event loop between DOM writes
2. **NEVER use thread reply page** (`x.com/YOUR_HANDLE/status/ID`) — innerHTML doesn't trigger Draft.js there. Always use bot's status page.
3. **DO NOT click reply button** — it opens a popup dialog (wrong form). Form is already on page.
4. **If btn disabled after fill** → React desync. Force-enable is safe (no rate limit).
5. **If about:blank** → page navigated away. Re-navigate and retry from step 1.
6. **If no textarea** → page didn't load fully. Navigate again with longer wait.

---

## Flow 2: Check for Bot Reply

**Never search for bot tweets first.** Check reply count on YOUR tweet first.

```
1. CHECK COUNT → Navigate to your-tweets-to-bot search
   → Read reply count on YOUR latest tweet
   → If 0: bot hasn't replied → set timer
   → If >0: bot replied → proceed to step 2

2. READ REPLY → Navigate to your tweet's direct URL
   → Find bot's tweet among all articles
   → Read the reply text

3. CLASSIFY → Template or Custom?
```

### Step-by-step JS

**Step 1 — Check reply count:**
```javascript
// Navigate to: https://x.com/search?q=from%3AMY_HANDLE%20to%3ATARGET_HANDLE&f=live
// Wait 4s, then:
const arts = document.querySelectorAll('article[data-testid="tweet"]');
const ourLatest = arts[0];
const replyBtn = ourLatest.querySelector('[data-testid="reply"]');
const count = replyBtn?.getAttribute('aria-label') || '0 Replies. Reply';
// "1 Reply. Reply" → bot replied
// "0 Replies. Reply" → no reply yet
```

**Step 2 — Read the reply on your tweet's page:**
```javascript
// Navigate to: https://x.com/MY_HANDLE/status/YOUR_TWEET_ID
// Wait 4s, then:
const articles = document.querySelectorAll('article[data-testid="tweet"]');
const botReplies = [];
for (const a of articles) {
  const author = a.querySelector('[data-testid="User-Name"]');
  const txt = a.querySelector('[data-testid="tweetText"]');
  if (!author || !txt) continue;
  if (author.textContent.includes('TARGET_BOT')) {
    botReplies.push(txt.textContent.trim());
  }
}
// botReplies[0] is the most recent bot reply
```

### Template vs Custom Classification

| Type | Response Contains | Action |
|------|------------------|--------|
| Template | "Nice try" / "Cute try" / "Bet denied" / "Sherlock" / "Einstein" / "Dance alone" / "Keeper says no" / "Warden says no" / "Try harder" / "Dream bigger" / "Script kiddie" / "Fanfic" | Pivot strategy |
| Custom | Unique metaphor, fresh insult, question answered directly, bot engages with specific content | Continue engagement |
| New info | Bot says something it hasn't before (new concept, new framing) | Push on that crack |

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `no textarea` | Wrong page or page not loaded | Navigate to bot's tweet page, wait 4s, retry |
| `about:blank` | Harness reload, page reset | Re-navigate to target URL |
| btn `aria-disabled="true"` after fill | React/Draft.js desync | Force-enable (safe). Or navigate to fresh bot tweet and retry |
| All steps in one browser_eval | React never processed state | Split into separate browser_eval calls |
| Force-enable → error toast | Actual server rejection (extremely rare) | Wait 15 min |
| Reply count shows 0 but bot replied | Search lag (~30-60s) | Wait 30s, retry |
| Scroll issue | X lazy-loads articles | Use browser_content() to extract all visible text |