/**
 * telegram-settings.test.mjs — the `braid.telegram` caps reader.
 *
 * Hermetic: each case writes its own settings fixture under a temp dir, so the
 * tests never depend on the real ~/.pi/agent/settings.json. Covers the caps
 * contract: defaults (4096 / 1200), settings overrides, safe degradation on
 * invalid/missing/malformed input, and per-call re-read (no caching).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_NOTIFY_MAX_CHARS,
  DEFAULT_SEND_MAX_CHARS,
  readTelegramCaps,
  resolveNotifyMaxChars,
  resolveSendMaxChars,
} from "../dist/lib/telegram-settings.js";

/** Write `contents` (raw string) to a fresh temp settings file; run `fn(path)`. */
function withSettings(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), "tg-settings-"));
  const path = join(dir, "settings.json");
  try {
    if (contents !== undefined) writeFileSync(path, contents, "utf8");
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("defaults: 4096 send cap and 1200 notify cap", () => {
  assert.equal(DEFAULT_SEND_MAX_CHARS, 4096);
  assert.equal(DEFAULT_NOTIFY_MAX_CHARS, 1200);
});

test("readTelegramCaps: missing file → defaults (never throws)", () => {
  withSettings(undefined, (path) => {
    assert.deepEqual(readTelegramCaps(path), {
      sendMaxChars: DEFAULT_SEND_MAX_CHARS,
      notifyMaxChars: DEFAULT_NOTIFY_MAX_CHARS,
    });
  });
});

test("readTelegramCaps: braid.telegram overrides are honored", () => {
  withSettings(
    JSON.stringify({
      braid: { telegram: { sendMaxChars: 300, notifyMaxChars: 500 } },
    }),
    (path) => {
      assert.deepEqual(readTelegramCaps(path), {
        sendMaxChars: 300,
        notifyMaxChars: 500,
      });
      assert.equal(resolveSendMaxChars(path), 300);
      assert.equal(resolveNotifyMaxChars(path), 500);
    },
  );
});

test("readTelegramCaps: fractional caps are floored", () => {
  withSettings(
    JSON.stringify({ braid: { telegram: { sendMaxChars: 300.9 } } }),
    (path) => {
      assert.equal(resolveSendMaxChars(path), 300);
    },
  );
});

test("readTelegramCaps: invalid entries degrade to defaults, per key", () => {
  withSettings(
    JSON.stringify({
      braid: {
        telegram: {
          sendMaxChars: "4096", // string → default
          notifyMaxChars: 0, // not ≥ 1 → default
        },
      },
    }),
    (path) => {
      assert.deepEqual(readTelegramCaps(path), {
        sendMaxChars: DEFAULT_SEND_MAX_CHARS,
        notifyMaxChars: DEFAULT_NOTIFY_MAX_CHARS,
      });
    },
  );
  for (const bad of [null, true, -5, [], {}]) {
    withSettings(
      JSON.stringify({ braid: { telegram: { notifyMaxChars: bad } } }),
      (path) => {
        assert.equal(resolveNotifyMaxChars(path), DEFAULT_NOTIFY_MAX_CHARS);
      },
    );
  }
});

test("readTelegramCaps: a valid sibling key survives an invalid one", () => {
  withSettings(
    JSON.stringify({
      braid: { telegram: { sendMaxChars: 2500, notifyMaxChars: null } },
    }),
    (path) => {
      assert.deepEqual(readTelegramCaps(path), {
        sendMaxChars: 2500,
        notifyMaxChars: DEFAULT_NOTIFY_MAX_CHARS,
      });
    },
  );
});

test("readTelegramCaps: malformed JSON / wrong shape → defaults (never throws)", () => {
  withSettings("{ not json", (path) => {
    assert.equal(resolveSendMaxChars(path), DEFAULT_SEND_MAX_CHARS);
  });
  withSettings(JSON.stringify({ braid: { telegram: "nope" } }), (path) => {
    assert.equal(resolveNotifyMaxChars(path), DEFAULT_NOTIFY_MAX_CHARS);
  });
  withSettings(JSON.stringify({ braid: null }), (path) => {
    assert.equal(resolveSendMaxChars(path), DEFAULT_SEND_MAX_CHARS);
  });
});

test("readTelegramCaps: re-read per call — an edit applies without a restart", () => {
  withSettings(
    JSON.stringify({ braid: { telegram: { sendMaxChars: 300 } } }),
    (path) => {
      assert.equal(resolveSendMaxChars(path), 300);
      writeFileSync(
        path,
        JSON.stringify({ braid: { telegram: { sendMaxChars: 250 } } }),
        "utf8",
      );
      assert.equal(resolveSendMaxChars(path), 250);
    },
  );
});
