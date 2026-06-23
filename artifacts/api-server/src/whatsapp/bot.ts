import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadContentFromMessage,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger as appLogger } from "../lib/logger.js";
import { onMessage as antiDeleteOnMessage, onDelete as antiDeleteOnDelete } from "./antidelete.js";
import { findCommand, findRawCommand, PREFIX } from "./command.js";

// Load all commands
import "./commands/alive.js";
import "./commands/antidelete.js";
import "./commands/status.js";
import "./commands/menu.js";
import "./commands/owner.js";
import "./commands/vv.js";
import "./commands/getpp.js";
import "./commands/cinesubz.js";
import "./commands/forward.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = process.env["SESSION_DIR"] || path.join(__dirname, "../../session");
const PAIRING_NUM = process.env["PAIRING_NUMBER"] || "";
const OWNER_NUM   = process.env["OWNER_NUMBER"] || "94726280182";
const SESSION_ID  = "nimsara_main";

if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
if (!existsSync(path.join(__dirname, "../../data"))) mkdirSync(path.join(__dirname, "../../data"), { recursive: true });
if (!existsSync(path.join(__dirname, "../../temp"))) mkdirSync(path.join(__dirname, "../../temp"), { recursive: true });

const silentLogger = pino({ level: "silent" });

let sock: ReturnType<typeof makeWASocket> | null = null;
let isConnected = false;
let reconnectTry = 0;
let currentQrDataUrl: string | null = null;

export function getBotStatus() {
  return {
    connected: isConnected,
    user: sock?.user ?? null,
  };
}

export function getBotQr() {
  return {
    qr: currentQrDataUrl,
    connected: isConnected,
  };
}

const OWNER_JID = OWNER_NUM + "@s.whatsapp.net";

async function downloadViewOnceBuffer(
  conn: ReturnType<typeof makeWASocket>,
  rawMsg: WAMessage,
  innerMedia: Record<string, unknown>,
  mediaType: string
): Promise<Buffer> {
  // Try direct download first; if mediaKey is missing, refresh via updateMediaMessage
  let media = innerMedia;
  if (!media["mediaKey"]) {
    try {
      const updated = await conn.updateMediaMessage(rawMsg);
      const updMsg = updated.message as Record<string, unknown>;
      let uType = Object.keys(updMsg)[0]!;
      let uInner = updMsg[uType] as Record<string, unknown>;
      if (uType === "viewOnceMessage" || uType === "viewOnceMessageV2" || uType === "viewOnceMessageV2Extension") {
        const nested = uInner["message"] as Record<string, unknown>;
        uType = Object.keys(nested)[0]!;
        uInner = nested[uType] as Record<string, unknown>;
      }
      media = uInner;
    } catch {
      // proceed with original
    }
  }
  const stream = await downloadContentFromMessage(
    media as Parameters<typeof downloadContentFromMessage>[0],
    mediaType.replace("Message", "") as Parameters<typeof downloadContentFromMessage>[1]
  );
  let buf = Buffer.from([]);
  for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
  return buf;
}

async function autoForwardViewOnce(
  conn: ReturnType<typeof makeWASocket>,
  msg: WAMessage
) {
  try {
    const from = msg.key.remoteJid || "";
    const rawSender = msg.key.participant || from;
    // Strip device suffix e.g. "94726280182:77@s.whatsapp.net" → "94726280182@s.whatsapp.net"
    const sender = rawSender.replace(/:\d+@/, "@");

    // Skip messages FROM the owner to avoid loop-forwarding
    if (sender === OWNER_JID || from === OWNER_JID) return;

    const message = msg.message as Record<string, unknown> | null;
    if (!message) return;

    let type = Object.keys(message)[0]!;
    let inner = message[type] as Record<string, unknown>;

    if (type === "viewOnceMessage" || type === "viewOnceMessageV2" || type === "viewOnceMessageV2Extension") {
      const innerMsg = inner["message"] as Record<string, unknown>;
      type = Object.keys(innerMsg)[0]!;
      inner = innerMsg[type] as Record<string, unknown>;
    } else {
      return; // Not a view-once
    }

    if (!["imageMessage", "videoMessage", "audioMessage"].includes(type)) return;

    appLogger.info({ from, type }, "View-once detected — forwarding to owner");

    const buffer = await downloadViewOnceBuffer(conn, msg, inner, type);
    if (!buffer.length) {
      appLogger.warn({ from }, "View-once buffer empty, skipping");
      return;
    }

    const pushname = msg.pushName || from;
    const label = `👁️ *View-Once Received*\n👤 *From:* ${pushname}\n📱 *Chat:* ${from}\n\n> *NIMSARA MD* 🌟`;

    if (type === "imageMessage") {
      await conn.sendMessage(OWNER_JID, { image: buffer, caption: label });
    } else if (type === "videoMessage") {
      await conn.sendMessage(OWNER_JID, { video: buffer, caption: label });
    } else if (type === "audioMessage") {
      await conn.sendMessage(OWNER_JID, { audio: buffer, mimetype: "audio/mpeg", ptt: false });
      await conn.sendMessage(OWNER_JID, { text: label });
    }

    appLogger.info({ from, type }, "View-once forwarded to owner ✅");
  } catch (err) {
    appLogger.warn({ err }, "autoForwardViewOnce failed");
  }
}

function extractBody(msg: WAMessage): string {
  const m = msg.message as Record<string, unknown> | null;
  if (!m) return "";
  return (
    (msg.message?.conversation ?? "") ||
    (msg.message?.extendedTextMessage?.text ?? "") ||
    (((m["imageMessage"] as Record<string, unknown>)?.["caption"] as string | undefined) ?? "") ||
    (((m["videoMessage"] as Record<string, unknown>)?.["caption"] as string | undefined) ?? "") ||
    ""
  );
}

function buildContext(conn: ReturnType<typeof makeWASocket>, msg: WAMessage) {
  const from = msg.key.remoteJid || "";
  const rawSender = msg.key.participant || from;
  const sender = rawSender.replace(/:\d+@/, "@");
  const pushname = msg.pushName || "";
  const isGroup = from.endsWith("@g.us");
  const senderNum = sender.replace(/[^0-9]/g, "").replace(/:.*/, "");
  // fromMe = message sent by the bot/owner account itself
  const isOwner = msg.key.fromMe === true || senderNum === OWNER_NUM;

  const m = msg.message as Record<string, unknown> | null;
  // Extract quoted from extendedTextMessage OR from any message type's contextInfo
  const anyMsg = m ? (Object.values(m)[0] as Record<string, unknown>) : undefined;
  const extCtx = (
    (m?.["extendedTextMessage"] as Record<string, unknown>)?.["contextInfo"] ||
    anyMsg?.["contextInfo"]
  ) as Record<string, unknown> | undefined;
  const quotedProto = extCtx?.["quotedMessage"];
  const quoted = quotedProto
    ? { message: quotedProto, key: { id: extCtx?.["stanzaId"], remoteJid: from, participant: extCtx?.["participant"] } }
    : null;

  const reply = (text: string) => conn.sendMessage(from, { text }, { quoted: msg as never });

  return { from, sender, pushname, isGroup, isOwner, quoted, reply, sessionId: SESSION_ID, args: [], rawMsg: msg };
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: silentLogger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
    },
    browser: ["NIMSARA MD", "Chrome", "3.0"],
    syncFullHistory: false,
    getMessage: async () => ({ conversation: "" }),
  });

  // Pairing code (no QR)
  if (PAIRING_NUM && !sock.authState.creds.registered) {
    await new Promise((r) => setTimeout(r, 3000));
    const code = await sock.requestPairingCode(PAIRING_NUM);
    console.log("\n============================");
    console.log(`PAIRING CODE: ${code}`);
    console.log("============================");
    console.log("WhatsApp → Linked Devices → Link with phone number → enter this code\n");
    appLogger.info({ code }, "WhatsApp pairing code generated");
  }

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n[NIMSARA MD] Scan this QR code with WhatsApp:");
      qrcode.generate(qr, { small: true });
      appLogger.info("QR code generated — scan with WhatsApp");
      // Store as data URL for the dashboard
      QRCode.toDataURL(qr, { width: 300, margin: 2 })
        .then((url: string) => { currentQrDataUrl = url; })
        .catch(() => {});
    }

    if (connection === "open") {
      isConnected = true;
      reconnectTry = 0;
      currentQrDataUrl = null;
      appLogger.info({ user: sock?.user?.id }, "WhatsApp connected ✅");
      console.log("[NIMSARA MD] ✅ WhatsApp connected! User:", sock?.user?.id);
    }

    if (connection === "close") {
      isConnected = false;
      const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
      appLogger.warn({ reason }, "WhatsApp disconnected");

      if (reason === DisconnectReason.loggedOut) {
        appLogger.error("Logged out — delete session folder and restart.");
        console.log("[NIMSARA MD] ❌ Logged out. Delete /session folder and restart.");
        return;
      }

      const delay = Math.min(5000 * ++reconnectTry, 60000);
      console.log(`[NIMSARA MD] Reconnecting in ${delay / 1000}s...`);
      setTimeout(() => { void startBot(); }, delay);
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // Incoming messages
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.message) continue;

      // AntiDelete: store
      await antiDeleteOnMessage(sock, msg, SESSION_ID);

      // Auto-forward view-once messages to owner
      await autoForwardViewOnce(sock!, msg);

      // React to command
      const body = extractBody(msg);

      const found = findCommand(body);
      if (!found) continue;

      const { command, args } = found;

      // ❤️ triggered as text → owner DM only (same as reaction)
      const strippedBody = body.startsWith(PREFIX) ? body.slice(PREFIX.length).trim() : body.trim();
      const isHeartTrigger = strippedBody === "❤️";

      const ctx = { ...buildContext(sock!, msg), args, ownerOnly: isHeartTrigger };

      // All commands are owner-only — silently ignore others
      if (!ctx.isOwner) continue;

      // React emoji
      if (command.react && sock) {
        try {
          await sock.sendMessage(msg.key.remoteJid!, {
            react: { text: command.react, key: msg.key },
          });
        } catch {}
      }

      try {
        await command.handler(sock, msg, ctx as Record<string, unknown>);
      } catch (err) {
        appLogger.error({ err, pattern: command.pattern }, "Command error");
      }
    }
  });

  // ❤️ React = vv command trigger
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      const reaction = msg.message?.reactionMessage;
      if (!reaction || reaction.text !== "❤️") continue;

      // Only owner can trigger
      const rawSender = msg.key.participant || msg.key.remoteJid || "";
      const sender = rawSender.replace(/:\d+@/, "@");
      const senderNum = sender.replace(/[^0-9]/g, "").replace(/:.*/, "");
      if (senderNum !== OWNER_NUM && msg.key.fromMe !== true) continue;

      const from = msg.key.remoteJid || "";

      // Fetch the message that was reacted to
      let targetMsg: WAMessage | null = null;
      try {
        const store = await sock!.loadMessage(from, reaction.key?.id || "");
        targetMsg = store ?? null;
      } catch {
        continue;
      }
      if (!targetMsg?.message) continue;

      const vvCommand = findRawCommand("vv");
      if (!vvCommand) continue;

      const reply = (text: string) => sock!.sendMessage(from, { text }, { quoted: msg as never });
      const ctx = {
        from,
        sender,
        isOwner: true,
        reply,
        quoted: null,
        rawMsg: targetMsg,
        args: [],
        sessionId: SESSION_ID,
        ownerOnly: true,
      };

      try {
        await vvCommand.handler(sock!, targetMsg, ctx as Record<string, unknown>);
        appLogger.info({ from }, "View-once retrieved via ❤️ reaction ✅");
      } catch (err) {
        appLogger.warn({ err }, "❤️ reaction vv failed");
      }
    }
  });

  // AntiDelete: on message delete
  sock.ev.on("messages.update", async (updates) => {
    await antiDeleteOnDelete(sock, updates, SESSION_ID);
  });
}

export async function initBot() {
  try {
    await startBot();
  } catch (err) {
    appLogger.error({ err }, "Bot startup error");
  }
}
