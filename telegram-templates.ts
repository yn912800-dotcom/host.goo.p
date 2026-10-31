/**
 * Telegram bot templates (Python / Node.js / PHP).
 *
 * All three share the same robust behaviour:
 *  - BOT_TOKEN from the environment, optional TELEGRAM_API_URL (self-hosted Bot API server)
 *  - getMe on start with retry + exponential back-off on network errors
 *  - exit with a clear message on 401/404 (invalid token) instead of retrying forever
 *  - long polling with request timeouts, automatic reconnect and explicit
 *    "connection lost" / "Reconnected" log lines
 *  - graceful shutdown on SIGTERM / SIGINT (sent by the platform on Stop / Restart)
 */
import type { BotTemplate, TemplateEnv } from "./bot-templates";

export const TG_TOKEN_ENV: TemplateEnv = {
  key: "BOT_TOKEN",
  label: "Telegram bot token",
  help: "Create a bot with @BotFather on Telegram and paste the token here.",
  required: true,
  secret: true,
  placeholder: "123456789:AA...",
};

const PY_BOT = `"""Telegram bot (pyTelegramBotAPI) with automatic reconnect."""
import os
import signal
import sys
import time

import telebot
from telebot import apihelper

TOKEN = os.environ.get("BOT_TOKEN", "").strip()
API_URL = os.environ.get("TELEGRAM_API_URL", "https://api.telegram.org").rstrip("/")

if not TOKEN:
    print("ERROR: BOT_TOKEN is not set. Add it in the Environment tab, then restart.", file=sys.stderr, flush=True)
    sys.exit(1)

apihelper.API_URL = API_URL + "/bot{0}/{1}"
apihelper.FILE_URL = API_URL + "/file/bot{0}/{1}"
apihelper.CONNECT_TIMEOUT = 10
apihelper.READ_TIMEOUT = 30

# ── connection tracking: log when the connection drops and when it comes back ──
_state = {"down": False, "since": 0.0}
_original_get_updates = apihelper.get_updates


def _tracked_get_updates(*args, **kwargs):
    if _state["down"]:
        # Short poll while reconnecting → recovery is confirmed immediately (not after a 25s long poll).
        # In pyTelegramBotAPI "long_polling_timeout" is the value sent to Telegram as getUpdates?timeout.
        kwargs["long_polling_timeout"] = 1
    try:
        result = _original_get_updates(*args, **kwargs)
    except apihelper.ApiTelegramException as e:
        if e.error_code in (401, 404):
            print(f"ERROR: Telegram rejected BOT_TOKEN ({e.error_code} {e.description}).", file=sys.stderr, flush=True)
            os._exit(2)
        if e.error_code == 409:
            print("WARN: 409 Conflict — another instance is polling with this token.", flush=True)
        _mark_down(f"Telegram {e.error_code}: {e.description}")
        raise
    except Exception as e:  # network errors, timeouts, bad gateway ...
        _mark_down(f"{e.__class__.__name__}: {str(e)[:160]}")
        raise
    if _state["down"]:
        _state["down"] = False
        print(f"Reconnected to Telegram ✅ (offline for {time.time() - _state['since']:.0f}s) — polling resumed", flush=True)
    return result


def _mark_down(reason: str) -> None:
    if not _state["down"]:
        _state["down"] = True
        _state["since"] = time.time()
        print(f"WARN: connection to Telegram lost ({reason}) — reconnecting automatically...", flush=True)


apihelper.get_updates = _tracked_get_updates

bot = telebot.TeleBot(TOKEN, threaded=False)


@bot.message_handler(commands=["start", "help"])
def start(message):
    bot.reply_to(
        message,
        f"👋 Hello {message.from_user.first_name}! I'm running on •-تــيــ۾ إڪـXـس-• (Python).\\n"
        "Commands: /ping — send me any text and I'll echo it.",
    )


@bot.message_handler(commands=["ping"])
def ping(message):
    bot.reply_to(message, "pong 🏓")


@bot.message_handler(func=lambda m: True, content_types=["text"])
def echo(message):
    print(f"[message] {message.from_user.id}: {message.text}", flush=True)
    bot.reply_to(message, message.text)


def connect():
    delay = 2
    while True:
        try:
            return bot.get_me()
        except apihelper.ApiTelegramException as e:
            if e.error_code in (401, 404):
                print(f"ERROR: Telegram rejected BOT_TOKEN ({e.error_code} {e.description}). Fix it in the Environment tab.", file=sys.stderr, flush=True)
                sys.exit(2)
            reason = f"Telegram {e.error_code}: {e.description}"
        except Exception as e:  # noqa: BLE001
            reason = f"{e.__class__.__name__}: {str(e)[:160]}"
        print(f"WARN: cannot reach Telegram ({reason}) — retrying in {delay}s", flush=True)
        time.sleep(delay)
        delay = min(delay * 2, 60)


def shutdown(signum, _frame):
    print("Shutting down gracefully...", flush=True)
    bot.stop_polling()
    sys.exit(0)


signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)

me = connect()
print(f"Connected to Telegram as @{me.username} (id {me.id}). Polling for updates...", flush=True)
# logger_level=None: connection problems are reported by the tracker above (no noisy tracebacks).
bot.infinity_polling(skip_pending=True, timeout=25, long_polling_timeout=25, logger_level=None)
`;

const NODE_BOT = `// Telegram bot for Node.js 18+ — no dependencies (native fetch), automatic reconnect.
const TOKEN = (process.env.BOT_TOKEN || "").trim();
const API = (process.env.TELEGRAM_API_URL || "https://api.telegram.org").replace(/\\/+$/, "");

if (!TOKEN) {
  console.error("ERROR: BOT_TOKEN is not set. Add it in the Environment tab, then restart.");
  process.exit(1);
}

class TelegramError extends Error {
  constructor(code, description) {
    super(description);
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopping = false;

async function call(method, params = {}, timeoutMs = 15000) {
  const res = await fetch(\`\${API}/bot\${TOKEN}/\${method}\`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new TelegramError(res.status, \`HTTP \${res.status} (non-JSON response)\`);
  }
  if (!data.ok) throw new TelegramError(data.error_code || res.status, data.description || "Unknown error");
  return data.result;
}

function describe(e) {
  if (e instanceof TelegramError) return \`Telegram \${e.code}: \${e.message}\`;
  if (e && e.name === "TimeoutError") return "request timed out";
  return (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || String(e);
}

const isFatal = (e) => e instanceof TelegramError && (e.code === 401 || e.code === 404);

async function connect() {
  let delay = 2000;
  for (;;) {
    try {
      return await call("getMe");
    } catch (e) {
      if (isFatal(e)) {
        console.error(\`ERROR: Telegram rejected BOT_TOKEN (\${describe(e)}). Fix it in the Environment tab.\`);
        process.exit(2);
      }
      console.log(\`WARN: cannot reach Telegram (\${describe(e)}) — retrying in \${delay / 1000}s\`);
      await sleep(delay);
      delay = Math.min(delay * 2, 60000);
    }
  }
}

async function handle(msg) {
  if (!msg.text) return;
  console.log(\`[message] \${msg.from.id}: \${msg.text}\`);
  let reply;
  if (msg.text === "/start" || msg.text === "/help")
    reply = \`👋 Hello \${msg.from.first_name}! I'm running on •-تــيــ۾ إڪـXـس-• (Node.js).\\nCommands: /ping — send me any text and I'll echo it.\`;
  else if (msg.text === "/ping") reply = "pong 🏓";
  else reply = msg.text;
  await call("sendMessage", { chat_id: msg.chat.id, text: reply, reply_to_message_id: msg.message_id });
}

async function main() {
  const me = await connect();
  console.log(\`Connected to Telegram as @\${me.username} (id \${me.id}). Polling for updates...\`);
  await call("deleteWebhook", { drop_pending_updates: true }).catch((e) =>
    console.log(\`WARN: deleteWebhook failed (\${describe(e)})\`)
  );

  let offset = 0;
  let down = false;
  let downSince = 0;
  let delay = 1000;
  while (!stopping) {
    try {
      const updates = await call("getUpdates", { offset, timeout: down ? 1 : 25, allowed_updates: ["message"] }, down ? 10000 : 35000);
      if (down) {
        console.log(\`Reconnected to Telegram ✅ (offline for \${Math.round((Date.now() - downSince) / 1000)}s) — polling resumed\`);
        down = false;
        delay = 1000;
      }
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) await handle(u.message).catch((e) => console.log(\`WARN: failed to reply (\${describe(e)})\`));
      }
    } catch (e) {
      if (stopping) break;
      if (isFatal(e)) {
        console.error(\`ERROR: Telegram rejected BOT_TOKEN (\${describe(e)}).\`);
        process.exit(2);
      }
      if (e instanceof TelegramError && e.code === 409)
        console.log("WARN: 409 Conflict — another instance is polling with this token.");
      if (!down) {
        down = true;
        downSince = Date.now();
        console.log(\`WARN: connection to Telegram lost (\${describe(e)}) — reconnecting automatically...\`);
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 10000);
    }
  }
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.once(sig, () => {
    stopping = true;
    console.log("Shutting down gracefully...");
    setTimeout(() => process.exit(0), 300);
  });
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
`;

const PHP_BOT = `<?php
// Telegram bot for PHP 8 — no dependencies (cURL), automatic reconnect.
$token = trim(getenv('BOT_TOKEN') ?: '');
$apiBase = rtrim(getenv('TELEGRAM_API_URL') ?: 'https://api.telegram.org', '/');
if ($token === '') {
    fwrite(STDERR, "ERROR: BOT_TOKEN is not set. Add it in the Environment tab, then restart.\\n");
    exit(1);
}

class TelegramError extends RuntimeException {}
class NetworkError extends RuntimeException {}

$stopping = false;
if (function_exists('pcntl_async_signals')) {
    pcntl_async_signals(true);
    $onStop = function () use (&$stopping) { $stopping = true; echo "Shutting down gracefully...\\n"; exit(0); };
    pcntl_signal(SIGTERM, $onStop);
    pcntl_signal(SIGINT, $onStop);
}

function tg(string $method, array $params = [], int $timeout = 15) {
    global $token, $apiBase;
    $ch = curl_init("{$apiBase}/bot{$token}/{$method}");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($params),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => $timeout,
    ]);
    // curl_multi + short select() slices instead of a blocking curl_exec(): SIGTERM/SIGINT
    // handlers run within ~250 ms even during a 25 s long poll → fast, graceful Stop/Restart.
    $mh = curl_multi_init();
    curl_multi_add_handle($mh, $ch);
    do {
        $mrc = curl_multi_exec($mh, $running);
        if ($running) curl_multi_select($mh, 0.25);
    } while ($running && $mrc === CURLM_OK);
    $info = curl_multi_info_read($mh);
    $code = $info ? $info['result'] : CURLE_OK;
    $res = curl_multi_getcontent($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_multi_remove_handle($mh, $ch);
    curl_multi_close($mh);
    curl_close($ch);
    if ($code !== CURLE_OK) throw new NetworkError(curl_strerror($code));
    if ($res === null || $res === '') throw new NetworkError("Empty reply from server (HTTP {$status})");
    $data = json_decode($res, true);
    if (!is_array($data)) throw new NetworkError("HTTP {$status} (non-JSON response)");
    if (!($data['ok'] ?? false)) throw new TelegramError($data['description'] ?? 'Unknown error', (int)($data['error_code'] ?? $status));
    return $data['result'];
}

function fatal(Throwable $e): bool {
    return $e instanceof TelegramError && in_array($e->getCode(), [401, 404], true);
}
function describe(Throwable $e): string {
    return $e instanceof TelegramError ? "Telegram {$e->getCode()}: {$e->getMessage()}" : $e->getMessage();
}

// ── connect (getMe) with back-off ──
$delay = 2;
while (true) {
    try {
        $me = tg('getMe');
        break;
    } catch (Throwable $e) {
        if (fatal($e)) {
            fwrite(STDERR, "ERROR: Telegram rejected BOT_TOKEN (" . describe($e) . "). Fix it in the Environment tab.\\n");
            exit(2);
        }
        echo "WARN: cannot reach Telegram (" . describe($e) . ") — retrying in {$delay}s\\n";
        sleep($delay);
        $delay = min($delay * 2, 60);
    }
}
echo "Connected to Telegram as @{$me['username']} (id {$me['id']}, PHP " . PHP_VERSION . "). Polling for updates...\\n";
try { tg('deleteWebhook', ['drop_pending_updates' => true]); } catch (Throwable $e) { echo "WARN: deleteWebhook failed (" . describe($e) . ")\\n"; }

$offset = 0;
$down = false;
$downSince = 0;
$delay = 1;
while (!$stopping) {
    try {
        $updates = tg('getUpdates', ['offset' => $offset, 'timeout' => $down ? 1 : 25, 'allowed_updates' => ['message']], $down ? 10 : 35);
        if ($down) {
            echo "Reconnected to Telegram ✅ (offline for " . (time() - $downSince) . "s) — polling resumed\\n";
            $down = false;
            $delay = 1;
        }
        foreach ($updates as $u) {
            $offset = $u['update_id'] + 1;
            $msg = $u['message'] ?? null;
            if (!$msg || !isset($msg['text'])) continue;
            $text = $msg['text'];
            echo "[message] {$msg['from']['id']}: {$text}\\n";
            if ($text === '/start' || $text === '/help') {
                $reply = "👋 Hello {$msg['from']['first_name']}! I'm running on •-تــيــ۾ إڪـXـس-• (PHP).";
            } elseif ($text === '/ping') {
                $reply = 'pong 🏓';
            } else {
                $reply = $text;
            }
            try {
                tg('sendMessage', ['chat_id' => $msg['chat']['id'], 'text' => $reply, 'reply_to_message_id' => $msg['message_id']]);
            } catch (Throwable $e) {
                echo "WARN: failed to reply (" . describe($e) . ")\\n";
            }
        }
    } catch (Throwable $e) {
        if (fatal($e)) {
            fwrite(STDERR, "ERROR: Telegram rejected BOT_TOKEN (" . describe($e) . ").\\n");
            exit(2);
        }
        if ($e instanceof TelegramError && $e->getCode() === 409) echo "WARN: 409 Conflict — another instance is polling with this token.\\n";
        if (!$down) {
            $down = true;
            $downSince = time();
            echo "WARN: connection to Telegram lost (" . describe($e) . ") — reconnecting automatically...\\n";
        }
        sleep($delay);
        $delay = min($delay * 2, 10);
    }
}
`;

export const TELEGRAM_TEMPLATES: BotTemplate[] = [
  {
    id: "telegram-python",
    platform: "telegram",
    language: "python",
    title: "Telegram bot · Python",
    description: "pyTelegramBotAPI long polling with auto-reconnect: /start, /ping, echo.",
    runtime: "python",
    entryPoint: "bot.py",
    startCommand: "python bot.py",
    installCommand: "pip install -r requirements.txt",
    env: [TG_TOKEN_ENV],
    files: [
      { path: "requirements.txt", content: "pyTelegramBotAPI>=4.14\n" },
      { path: "bot.py", content: PY_BOT },
    ],
  },
  {
    id: "telegram-node",
    platform: "telegram",
    language: "node",
    title: "Telegram bot · Node.js",
    description: "Dependency-free long polling (native fetch) with auto-reconnect.",
    runtime: "node",
    entryPoint: "index.js",
    startCommand: "node index.js",
    env: [TG_TOKEN_ENV],
    files: [
      {
        path: "package.json",
        content:
          JSON.stringify(
            { name: "telegram-bot", version: "1.0.0", private: true, main: "index.js", scripts: { start: "node index.js" }, engines: { node: ">=18" } },
            null,
            2
          ) + "\n",
      },
      { path: "index.js", content: NODE_BOT },
    ],
  },
  {
    id: "telegram-php",
    platform: "telegram",
    language: "php",
    title: "Telegram bot · PHP",
    description: "Dependency-free PHP long polling (cURL) with auto-reconnect.",
    runtime: "php",
    entryPoint: "bot.php",
    startCommand: "php bot.php",
    env: [TG_TOKEN_ENV],
    files: [{ path: "bot.php", content: PHP_BOT }],
  },
];
