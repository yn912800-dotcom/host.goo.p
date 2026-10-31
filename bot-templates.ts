/** Ready-to-deploy bot templates (shared by the wizard UI and the API). */
import { TELEGRAM_TEMPLATES } from "./telegram-templates";

export type TemplateEnv = {
  key: string;
  label: string;
  help: string;
  required: boolean;
  secret: boolean;
  placeholder?: string;
};

export type BotTemplate = {
  id: string;
  platform: "telegram" | "whatsapp";
  language: "python" | "node" | "php";
  title: string;
  description: string;
  runtime: "python" | "node" | "php";
  entryPoint: string;
  startCommand: string;
  installCommand?: string;
  env: TemplateEnv[];
  files: { path: string; content: string }[];
  /** Shown after deploy (e.g. webhook URL instructions). */
  notes?: string;
};


const CLOUD_API_ENV: TemplateEnv[] = [
  { key: "WHATSAPP_TOKEN", label: "WhatsApp Cloud API access token", help: "Meta for Developers → your app → WhatsApp → API Setup.", required: true, secret: true },
  { key: "PHONE_NUMBER_ID", label: "Phone number ID", help: "Shown on the same API Setup page.", required: true, secret: false },
  { key: "VERIFY_TOKEN", label: "Webhook verify token", help: "Any random string. Use the same value when configuring the webhook in Meta.", required: true, secret: true, placeholder: "my-verify-token" },
];

const CLOUD_API_NOTES =
  "In Meta for Developers → WhatsApp → Configuration set the Callback URL to  https://<this-site>/apps/<server-id>/webhook  and the verify token to your VERIFY_TOKEN, then subscribe to the 'messages' field.";

export const BOT_TEMPLATES: BotTemplate[] = [
  ...TELEGRAM_TEMPLATES,
  // ─────────────── WhatsApp · Node.js (Baileys, QR / pairing code) ───────────────
  {
    id: "whatsapp-node",
    platform: "whatsapp",
    language: "node",
    title: "WhatsApp bot · Node.js (QR)",
    description: "Baileys bot — link your number by scanning a QR code or with a pairing code. Commands: !ping, !help, !echo.",
    runtime: "node",
    entryPoint: "index.js",
    startCommand: "node index.js",
    installCommand: "npm install",
    env: [
      {
        key: "WA_PHONE",
        label: "Phone number for pairing code (optional)",
        help: "International format without + (e.g. 201234567890). Leave empty to link with a QR code instead.",
        required: false,
        secret: false,
      },
    ],
    files: [
      {
        path: "package.json",
        content: JSON.stringify(
          {
            name: "whatsapp-bot",
            version: "1.0.0",
            private: true,
            main: "index.js",
            scripts: { start: "node index.js" },
            dependencies: { "@whiskeysockets/baileys": "^6.7.9", pino: "^9.5.0" },
          },
          null,
          2
        ) + "\n",
      },
      {
        path: "index.js",
        content: `const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const pino = require("pino");

const PHONE = (process.env.WA_PHONE || "").replace(/\\D/g, "");

async function start() {
  // Session is stored in ./auth_info (kept across restarts & redeploys)
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "warn" }),
    printQRInTerminal: false,
    browser: ["•-تــيــ۾ إڪـXـس-•", "Chrome", "1.0.0"],
  });
  sock.ev.on("creds.update", saveCreds);

  let pairingRequested = false;
  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      if (PHONE && !pairingRequested && !sock.authState.creds.registered) {
        pairingRequested = true;
        try {
          const code = await sock.requestPairingCode(PHONE);
          console.log(\`[[WA_PAIRING]]\${code}\`);
          console.log(\`Pairing code: \${code} — WhatsApp → Linked devices → Link with phone number\`);
        } catch (e) {
          console.error("Pairing code request failed:", e.message);
        }
      } else if (!PHONE) {
        console.log(\`[[QR]]\${qr}\`);
        console.log("Scan the QR code: WhatsApp → Linked devices → Link a device");
      }
    }
    if (connection === "open") {
      console.log(\`[[WA_CONNECTED]] WhatsApp connected as \${sock.user && sock.user.id}\`);
    }
    if (connection === "close") {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode
        : undefined;
      if (code === DisconnectReason.loggedOut) {
        console.error("Logged out from WhatsApp. Delete the auth_info session (redeploy after removing it) to link again.");
        process.exit(1);
      }
      console.log(\`Connection closed (\${code}). Reconnecting...\`);
      setTimeout(start, 3000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;
      const text = m.message.conversation || (m.message.extendedTextMessage && m.message.extendedTextMessage.text);
      if (!text) continue;
      const jid = m.key.remoteJid;
      console.log(\`[message] \${jid}: \${text}\`);
      const cmd = text.trim().toLowerCase();
      let reply = null;
      if (cmd === "!ping") reply = "pong 🏓";
      else if (cmd === "!help") reply = "🤖 •-تــيــ۾ إڪـXـس-• WhatsApp bot\\n!ping — test\\n!echo <text> — repeat text";
      else if (cmd.startsWith("!echo ")) reply = text.trim().slice(6);
      if (reply) await sock.sendMessage(jid, { text: reply }, { quoted: m });
    }
  });
}

start().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
`,
      },
    ],
  },
  // ─────────────── WhatsApp · Python (Cloud API webhook) ───────────────
  {
    id: "whatsapp-python",
    platform: "whatsapp",
    language: "python",
    title: "WhatsApp bot · Python (Cloud API)",
    description: "Official WhatsApp Cloud API webhook bot — zero dependencies (http.server).",
    runtime: "python",
    entryPoint: "app.py",
    startCommand: "python app.py",
    env: CLOUD_API_ENV,
    notes: CLOUD_API_NOTES,
    files: [
      {
        path: "app.py",
        content: `"""WhatsApp Cloud API webhook bot (no external dependencies)."""
import json
import os
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

TOKEN = os.environ.get("WHATSAPP_TOKEN", "")
PHONE_NUMBER_ID = os.environ.get("PHONE_NUMBER_ID", "")
VERIFY_TOKEN = os.environ.get("VERIFY_TOKEN", "")
PORT = int(os.environ.get("PORT", "8000"))
HOST = os.environ.get("HOST", "0.0.0.0")


def send_text(to: str, body: str) -> None:
    req = urllib.request.Request(
        f"https://graph.facebook.com/v20.0/{PHONE_NUMBER_ID}/messages",
        data=json.dumps({"messaging_product": "whatsapp", "to": to, "type": "text", "text": {"body": body}}).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            print(f"[sent] to {to}: HTTP {r.status}")
    except Exception as e:  # noqa: BLE001
        print(f"[error] send failed: {e}")


def handle_message(msg: dict) -> None:
    if msg.get("type") != "text":
        return
    sender = msg["from"]
    text = msg["text"]["body"].strip()
    print(f"[message] {sender}: {text}")
    cmd = text.lower()
    if cmd in ("ping", "!ping"):
        send_text(sender, "pong 🏓")
    elif cmd in ("help", "!help"):
        send_text(sender, "🤖 •-تــيــ۾ إڪـXـس-• WhatsApp bot (Python)\\nping — test\\nAnything else is echoed back.")
    else:
        send_text(sender, f"You said: {text}")


class Handler(BaseHTTPRequestHandler):
    def _reply(self, code: int, body: str, ctype: str = "text/plain") -> None:
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path.rstrip("/") == "/webhook":
            q = parse_qs(url.query)
            if q.get("hub.mode", [""])[0] == "subscribe" and q.get("hub.verify_token", [""])[0] == VERIFY_TOKEN and VERIFY_TOKEN:
                print("[webhook] verified by Meta")
                return self._reply(200, q.get("hub.challenge", [""])[0])
            return self._reply(403, "Verification failed")
        self._reply(200, "WhatsApp bot is running ✅")

    def do_POST(self):
        if urlparse(self.path).path.rstrip("/") != "/webhook":
            return self._reply(404, "Not found")
        length = int(self.headers.get("Content-Length", "0") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            for entry in payload.get("entry", []):
                for change in entry.get("changes", []):
                    for msg in change.get("value", {}).get("messages", []):
                        handle_message(msg)
        except Exception as e:  # noqa: BLE001
            print(f"[error] bad webhook payload: {e}")
        self._reply(200, "EVENT_RECEIVED")

    def log_message(self, fmt, *args):
        print(f"[http] {self.command} {self.path} -> {args[1] if len(args) > 1 else ''}")


if __name__ == "__main__":
    if not (TOKEN and PHONE_NUMBER_ID and VERIFY_TOKEN):
        print("WARNING: WHATSAPP_TOKEN / PHONE_NUMBER_ID / VERIFY_TOKEN are not all set (Environment tab).")
    print(f"WhatsApp webhook bot listening on {HOST}:{PORT} — webhook path: /webhook")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
`,
      },
    ],
  },
  // ─────────────── WhatsApp · PHP (Cloud API webhook) ───────────────
  {
    id: "whatsapp-php",
    platform: "whatsapp",
    language: "php",
    title: "WhatsApp bot · PHP (Cloud API)",
    description: "Official WhatsApp Cloud API webhook bot served by PHP's built-in server.",
    runtime: "php",
    entryPoint: "index.php",
    startCommand: "php -S 127.0.0.1:$PORT index.php",
    env: CLOUD_API_ENV,
    notes: CLOUD_API_NOTES,
    files: [
      {
        path: "index.php",
        content: `<?php
// WhatsApp Cloud API webhook bot (router script for "php -S").
$token = getenv('WHATSAPP_TOKEN') ?: '';
$phoneId = getenv('PHONE_NUMBER_ID') ?: '';
$verify = getenv('VERIFY_TOKEN') ?: '';
$path = rtrim(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH), '/');

function out(string $s) { file_put_contents('php://stdout', $s . "\\n"); }

function send_text(string $to, string $body) {
    global $token, $phoneId;
    $ch = curl_init("https://graph.facebook.com/v20.0/{$phoneId}/messages");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => ["Authorization: Bearer {$token}", 'Content-Type: application/json'],
        CURLOPT_POSTFIELDS => json_encode(['messaging_product' => 'whatsapp', 'to' => $to, 'type' => 'text', 'text' => ['body' => $body]]),
        CURLOPT_TIMEOUT => 15,
    ]);
    curl_exec($ch);
    out("[sent] to {$to}: HTTP " . curl_getinfo($ch, CURLINFO_HTTP_CODE));
    curl_close($ch);
}

if ($path === '/webhook' && $_SERVER['REQUEST_METHOD'] === 'GET') {
    if (($_GET['hub_mode'] ?? '') === 'subscribe' && $verify !== '' && ($_GET['hub_verify_token'] ?? '') === $verify) {
        out('[webhook] verified by Meta');
        echo $_GET['hub_challenge'] ?? '';
    } else {
        http_response_code(403);
        echo 'Verification failed';
    }
    return true;
}

if ($path === '/webhook' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $payload = json_decode(file_get_contents('php://input'), true) ?: [];
    foreach ($payload['entry'] ?? [] as $entry) {
        foreach ($entry['changes'] ?? [] as $change) {
            foreach ($change['value']['messages'] ?? [] as $msg) {
                if (($msg['type'] ?? '') !== 'text') continue;
                $from = $msg['from'];
                $text = trim($msg['text']['body']);
                out("[message] {$from}: {$text}");
                $cmd = strtolower($text);
                if ($cmd === 'ping' || $cmd === '!ping') send_text($from, 'pong 🏓');
                elseif ($cmd === 'help' || $cmd === '!help') send_text($from, "🤖 •-تــيــ۾ إڪـXـس-• WhatsApp bot (PHP)\\nping — test");
                else send_text($from, "You said: {$text}");
            }
        }
    }
    echo 'EVENT_RECEIVED';
    return true;
}

echo 'WhatsApp bot is running ✅';
return true;
`,
      },
    ],
  },
];

export function getTemplate(id: string) {
  return BOT_TEMPLATES.find((t) => t.id === id);
}
