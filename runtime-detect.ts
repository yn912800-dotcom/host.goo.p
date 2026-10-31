export type DetectedRuntime = {
  runtime:
    | "python"
    | "node"
    | "php"
    | "static"
    | "java"
    | "go"
    | "ruby"
    | "rust"
    | "deno"
    | "shell";
  version?: string;
  entryPoint?: string;
  installCommand?: string;
  startCommand?: string;
  dependencies?: string[];
  confidence: number; // 0..1
  notes: string[];
};

type FileEntry = { path: string; content?: string };

/**
 * Analyze a list of file paths (and optional contents for key files) to detect runtime.
 */
const BOT_LIBS: { re: RegExp; label: string }[] = [
  { re: /pyTelegramBotAPI|telebot/i, label: "Telegram bot (pyTelegramBotAPI) — set BOT_TOKEN" },
  { re: /python-telegram-bot/i, label: "Telegram bot (python-telegram-bot) — set your token env var" },
  { re: /aiogram/i, label: "Telegram bot (aiogram) — set your token env var" },
  { re: /pyrogram|telethon/i, label: "Telegram client (Pyrogram/Telethon) — needs API_ID / API_HASH" },
  { re: /"telegraf"/i, label: "Telegram bot (Telegraf) — set BOT_TOKEN" },
  { re: /"node-telegram-bot-api"|"grammy"/i, label: "Telegram bot (Node.js) — set your token env var" },
  { re: /@whiskeysockets\/baileys|"baileys"/i, label: "WhatsApp bot (Baileys) — link with QR shown in the Console" },
  { re: /whatsapp-web\.js/i, label: "WhatsApp bot (whatsapp-web.js) — requires Chromium on the node; Baileys is recommended" },
  { re: /telegram-bot-sdk|telegram\/bot|longman\/telegram/i, label: "Telegram bot (PHP SDK) — set your token env var" },
];

export function detectRuntime(files: FileEntry[]): DetectedRuntime {
  const base = detectRuntimeBase(files);
  const manifests = files
    .filter((f) => /^(requirements\.txt|pyproject\.toml|pipfile|package\.json|composer\.json)$/i.test(f.path))
    .map((f) => f.content ?? "")
    .join("\n");
  for (const lib of BOT_LIBS) if (lib.re.test(manifests)) base.notes.push(lib.label);
  return base;
}

function detectRuntimeBase(files: FileEntry[]): DetectedRuntime {
  const paths = new Set(files.map((f) => f.path.toLowerCase()));
  const byPath = new Map(files.map((f) => [f.path.toLowerCase(), f]));
  const notes: string[] = [];

  // Node.js
  if (paths.has("package.json")) {
    const pkg = byPath.get("package.json");
    let start: string | undefined;
    let deps: string[] = [];
    try {
      if (pkg?.content) {
        const parsed = JSON.parse(pkg.content) as {
          scripts?: Record<string, string>;
          main?: string;
          dependencies?: Record<string, string>;
        };
        start = parsed.scripts?.start || (parsed.main ? `node ${parsed.main}` : undefined);
        deps = Object.keys(parsed.dependencies ?? {});
        notes.push("Found package.json");
      }
    } catch {
      notes.push("package.json present but failed to parse");
    }
    if (!start) {
      for (const cand of ["index.js", "server.js", "app.js", "main.js", "bot.js"]) {
        if (paths.has(cand)) {
          start = `node ${cand}`;
          break;
        }
      }
    }
    return {
      runtime: "node",
      version: "20",
      entryPoint: start?.replace(/^node\s+/, ""),
      installCommand: paths.has("package-lock.json") ? "npm ci" : "npm install",
      startCommand: start || "npm start",
      dependencies: deps,
      confidence: 0.95,
      notes,
    };
  }

  // Python
  const pyIndicators = [
    "requirements.txt",
    "pyproject.toml",
    "pipfile",
    "main.py",
    "app.py",
    "server.py",
    "bot.py",
  ];
  if (pyIndicators.some((p) => paths.has(p))) {
    let entry: string | undefined;
    for (const cand of ["main.py", "app.py", "server.py", "bot.py"]) {
      if (paths.has(cand)) {
        entry = cand;
        break;
      }
    }
    if (!entry) {
      // find any .py file at root
      for (const p of paths) {
        if (p.endsWith(".py") && !p.includes("/")) {
          entry = p;
          break;
        }
      }
    }
    let install: string | undefined;
    if (paths.has("requirements.txt")) install = "pip install -r requirements.txt";
    else if (paths.has("pyproject.toml")) install = "pip install .";
    else if (paths.has("pipfile")) install = "pipenv install";
    notes.push(`Detected Python entry: ${entry ?? "none"}`);
    return {
      runtime: "python",
      version: "3.11",
      entryPoint: entry,
      installCommand: install,
      startCommand: entry ? `python ${entry}` : "python main.py",
      confidence: 0.9,
      notes,
    };
  }

  // PHP — any root-level .php file or composer.json
  const rootPhp = [...paths].filter((p) => p.endsWith(".php") && !p.includes("/"));
  if (rootPhp.length > 0 || paths.has("composer.json")) {
    const cli = ["bot.php", "main.php", "worker.php", "run.php", "start.php"].find((c) => paths.has(c));
    const install = paths.has("composer.json") ? "composer install --no-dev --no-interaction --no-progress" : undefined;
    if (cli || (!paths.has("index.php") && rootPhp.length > 0)) {
      const entry = cli ?? rootPhp.sort()[0];
      notes.push(`Detected PHP CLI script: ${entry} (long-running bot/worker)`);
      return { runtime: "php", entryPoint: entry, installCommand: install, startCommand: `php ${entry}`, confidence: 0.9, notes };
    }
    notes.push("Detected PHP web app — served by PHP's built-in server on $PORT");
    return {
      runtime: "php",
      entryPoint: paths.has("index.php") ? "index.php" : undefined,
      installCommand: install,
      startCommand: "php -S 127.0.0.1:$PORT -t .",
      confidence: 0.85,
      notes,
    };
  }

  // Python / Node.js without a manifest (loose entry files)
  const rootPy = [...paths].filter((p) => p.endsWith(".py") && !p.includes("/")).sort();
  if (rootPy.length > 0) {
    notes.push(`Detected Python entry: ${rootPy[0]}`);
    return { runtime: "python", entryPoint: rootPy[0], startCommand: `python ${rootPy[0]}`, confidence: 0.7, notes };
  }
  const jsEntry = ["index.js", "bot.js", "main.js", "server.js", "app.js"].find((c) => paths.has(c));
  if (jsEntry && !paths.has("index.html")) {
    notes.push(`Detected Node.js entry: ${jsEntry} (no package.json)`);
    return { runtime: "node", entryPoint: jsEntry, startCommand: `node ${jsEntry}`, confidence: 0.7, notes };
  }

  // Go
  if (paths.has("go.mod")) {
    return {
      runtime: "go",
      version: "1.22",
      installCommand: "go mod download",
      buildHint: true,
      startCommand: "go run .",
      confidence: 0.85,
      notes: ["Found go.mod"],
    } as DetectedRuntime;
  }

  // Rust
  if (paths.has("cargo.toml")) {
    return {
      runtime: "rust",
      version: "stable",
      startCommand: "cargo run --release",
      confidence: 0.8,
      notes: ["Found Cargo.toml"],
    };
  }

  // Ruby
  if (paths.has("gemfile") || paths.has("config.ru")) {
    return {
      runtime: "ruby",
      version: "3.2",
      installCommand: "bundle install",
      startCommand: paths.has("config.ru") ? "rackup -p $PORT" : "ruby main.rb",
      confidence: 0.75,
      notes: ["Found Ruby indicators"],
    };
  }

  // Java
  if (paths.has("pom.xml") || paths.has("build.gradle")) {
    return {
      runtime: "java",
      version: "17",
      installCommand: paths.has("pom.xml") ? "mvn package" : "gradle build",
      startCommand: "java -jar target/app.jar",
      confidence: 0.7,
      notes: ["Found Java build file"],
    };
  }

  // Static
  if (paths.has("index.html")) {
    return {
      runtime: "static",
      entryPoint: "index.html",
      startCommand: "static-server",
      confidence: 0.9,
      notes: ["Found index.html; serving as static site"],
    };
  }

  // Fallback: static if any html, else shell
  for (const p of paths) {
    if (p.endsWith(".html")) {
      return {
        runtime: "static",
        entryPoint: p,
        startCommand: "static-server",
        confidence: 0.6,
        notes: ["No index.html; using first .html file"],
      };
    }
  }

  return {
    runtime: "static",
    startCommand: "static-server",
    confidence: 0.3,
    notes: ["No clear runtime detected; defaulting to static hosting"],
  };
}
