import { cmd } from "../command.js";
import type makeWASocket from "@whiskeysockets/baileys";
import axios from "axios";
import sharp from "sharp";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Session Config ──────────────────────────────────────────────────────────

interface SessionConfig {
  botName?: string;
  thumbUrl?: string;
  movieDoc?: boolean;
}

function getSessionConfig(sessionId: string): SessionConfig {
  try {
    const file = path.join(__dirname, "../../data/session_config_" + sessionId + ".json");
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as SessionConfig;
  } catch {}
  return {};
}

function saveSessionConfig(sessionId: string, config: SessionConfig): void {
  try {
    const dataFolder = path.join(__dirname, "../../data");
    if (!existsSync(dataFolder)) mkdirSync(dataFolder, { recursive: true });
    const file = path.join(dataFolder, "session_config_" + sessionId + ".json");
    writeFileSync(file, JSON.stringify(config, null, 2));
  } catch {}
}

function getBotName(sessionId: string): string {
  return getSessionConfig(sessionId).botName || "SAYURA MOVIE HOME";
}

function getHardThumbUrl(sessionId: string): string {
  return (
    getSessionConfig(sessionId).thumbUrl ||
    "https://raw.githubusercontent.com/gojo1777/abc/refs/heads/main/IMG-20260226-WA0005.jpg"
  );
}

function isMovieDocOn(sessionId: string): boolean {
  return getSessionConfig(sessionId).movieDoc === true;
}

// ─── Types ───────────────────────────────────────────────────────────────────

type Conn = ReturnType<typeof makeWASocket>;

interface MovieResult {
  title: string;
  link: string;
}

interface DownloadOption {
  quality: string;
  size: string;
  link: string;
}

interface MovieInfo {
  title: string;
  image?: string;
  year?: string;
  rating?: string;
  duration?: string;
  country?: string;
  directors?: string;
  downloads: DownloadOption[];
}

interface DownloadLink {
  name: string;
  url: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function reactMsg(conn: Conn, jid: string, key: unknown, emoji: string): Promise<void> {
  try {
    await conn.sendMessage(jid, { react: { text: emoji, key: key as never } });
  } catch {}
}

async function makeThumbnail(
  moviePosterUrl: string | null,
  hardThumbUrl: string,
  movieDocOn: boolean
): Promise<Buffer | null> {
  const primaryUrl = movieDocOn && moviePosterUrl ? moviePosterUrl : hardThumbUrl;
  const fallbackUrl = hardThumbUrl;

  async function fetchThumb(url: string): Promise<Buffer> {
    const img = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer", timeout: 15000 });
    return await sharp(Buffer.from(img.data)).resize(300).jpeg({ quality: 65 }).toBuffer();
  }

  try {
    return await fetchThumb(primaryUrl);
  } catch {
    if (primaryUrl !== fallbackUrl) {
      try { return await fetchThumb(fallbackUrl); } catch {}
    }
    return null;
  }
}

function waitForReply(
  conn: Conn,
  from: string,
  replyToId: string,
  timeout = 120000
): Promise<{ msg: unknown; text: string }> {
  return new Promise((resolve, reject) => {
    const handler = ({ messages }: { messages: unknown[] }) => {
      const msg = messages[0] as Record<string, unknown> | undefined;
      if (!msg?.message) return;
      const m = msg.message as Record<string, unknown>;
      const ext = m.extendedTextMessage as Record<string, unknown> | undefined;
      const ctx = ext?.contextInfo as Record<string, unknown> | undefined;
      const text =
        (m.conversation as string | undefined) ||
        (ext?.text as string | undefined) ||
        "";
      const key = msg.key as Record<string, unknown>;
      if (key.remoteJid === from && ctx && ctx.stanzaId === replyToId) {
        conn.ev.off("messages.upsert", handler as never);
        resolve({ msg, text });
      }
    };
    conn.ev.on("messages.upsert", handler as never);
    setTimeout(() => {
      conn.ev.off("messages.upsert", handler as never);
      reject(new Error("Reply timeout"));
    }, timeout);
  });
}

async function sendDocWithCaption(
  conn: Conn,
  from: string,
  info: MovieInfo,
  file: { url: string; quality: string },
  quoted: unknown,
  footer: string,
  sessionId: string
): Promise<void> {
  const movieDocOn = isMovieDocOn(sessionId);
  const hardThumb = getHardThumbUrl(sessionId);
  const thumb = await makeThumbnail(info.image || null, hardThumb, movieDocOn);

  const captionText = `🎬 *${info.title}*\n*${file.quality}*\n\n${footer}`;
  const safeName = (info.title + ` (${file.quality}).mp4`).replace(/[/\\:*?"<>|]/g, "");

  const docMsg = await conn.sendMessage(
    from,
    {
      document: { url: file.url },
      fileName: safeName,
      mimetype: "video/mp4",
      jpegThumbnail: thumb ?? undefined,
      caption: captionText,
    } as never,
    { quoted: quoted as never }
  );

  await reactMsg(conn, from, (docMsg as Record<string, unknown>).key, "✅");
}

// ─── Commands ────────────────────────────────────────────────────────────────

const API_BASE = "https://api-dark-shan-yt.koyeb.app/movie";
const API_KEY  = "e3eefa2ab2efe9a1";

cmd(
  {
    pattern: "cinesubz",
    desc: "CineSubz movie downloader",
    category: "downloader",
    react: "🔍",
  },
  async (conn, mek, { from, args, reply, sessionId }) => {
    const sock = conn as unknown as Conn;
    const q = (args as string[]).join(" ").trim();

    try {
      if (!q) return (reply as (t: string) => Promise<void>)("Example: .cinesubz Avatar");

      const footer = "✫ " + getBotName(sessionId as string) + " ✫";
      await reactMsg(sock, from as string, (mek as Record<string, unknown>).key, "🔍");

      // Search
      const searchRes = await axios.get<{ data: MovieResult[] }>(
        `${API_BASE}/cinesubz-search?q=${encodeURIComponent(q)}&apikey=${API_KEY}`
      );
      const results = searchRes.data?.data;
      if (!results?.length) return (reply as (t: string) => Promise<void>)("No results found.");

      // Show list
      let listText = "🎬 *CineSubz Results*\n\n";
      results.slice(0, 10).forEach((v, i) => {
        listText += `*${i + 1}.* ${v.title}\n`;
      });

      const listMsg = await sock.sendMessage(
        from as string,
        { text: listText + "\nReply with number\n\n" + footer },
        { quoted: mek as never }
      );
      const listMsgKey = (listMsg as Record<string, unknown>).key as Record<string, unknown>;

      // Wait for movie selection
      const sel1 = await waitForReply(sock, from as string, listMsgKey.id as string);
      const index = parseInt(sel1.text) - 1;
      if (isNaN(index) || !results[index])
        return (reply as (t: string) => Promise<void>)("Invalid number.");
      await reactMsg(sock, from as string, (sel1.msg as Record<string, unknown>).key, "🎬");

      // Get movie info
      const infoRes = await axios.get<{ data: MovieInfo }>(
        `${API_BASE}/cinesubz-info?url=${encodeURIComponent(results[index]!.link)}&apikey=${API_KEY}`
      );
      const info = infoRes.data?.data;
      if (!info) return (reply as (t: string) => Promise<void>)("Failed to get movie info.");

      let infoText = `🎬 *${info.title}*\n\n`;
      if (info.year)      infoText += `📅 *Year:* ${info.year}\n`;
      if (info.rating)    infoText += `⭐ *Rating:* ${info.rating}\n`;
      if (info.duration)  infoText += `⏱️ *Duration:* ${info.duration}\n`;
      if (info.country)   infoText += `🌍 *Country:* ${info.country}\n`;
      if (info.directors) infoText += `🎬 *Directors:* ${info.directors}\n`;

      infoText += "\n*Available Qualities:*";
      info.downloads.forEach((d, i) => {
        infoText += `\n*${i + 1}.* ${d.quality} (${d.size})`;
      });

      const infoMsg = await sock.sendMessage(
        from as string,
        {
          image: { url: info.image },
          caption: infoText + "\n\nReply with download number\n" + footer,
        } as never,
        { quoted: sel1.msg as never }
      );
      const infoMsgKey = (infoMsg as Record<string, unknown>).key as Record<string, unknown>;

      // Wait for quality selection
      const sel2 = await waitForReply(sock, from as string, infoMsgKey.id as string);
      const dIndex = parseInt(sel2.text) - 1;
      if (isNaN(dIndex) || !info.downloads[dIndex])
        return (reply as (t: string) => Promise<void>)("Invalid download number.");
      await reactMsg(sock, from as string, (sel2.msg as Record<string, unknown>).key, "⬇️");

      // Get download link
      const dlRes = await axios.get<{ data: { download: DownloadLink[] } }>(
        `${API_BASE}/cinesubz-download?url=${encodeURIComponent(info.downloads[dIndex]!.link)}&apikey=${API_KEY}`
      );
      const downloadLinks = dlRes.data?.data?.download;

      const pix     = downloadLinks?.find((v) => v.name.toLowerCase() === "pix");
      const unknown = downloadLinks?.find((v) => v.name.toLowerCase() === "unknown");
      const selected = pix || unknown;

      if (!selected)
        return (reply as (t: string) => Promise<void>)("No downloadable link found.");

      await sendDocWithCaption(
        sock,
        from as string,
        info,
        { url: selected.url, quality: info.downloads[dIndex]!.quality },
        sel2.msg,
        footer,
        sessionId as string
      );
    } catch (e) {
      await (reply as (t: string) => Promise<void>)("Error: " + (e as Error).message);
    }
  }
);

// ─── Owner Commands ───────────────────────────────────────────────────────────

cmd(
  {
    pattern: "moviedoc",
    react: "🖼️",
    desc: "Toggle movie poster as doc thumbnail (on/off)",
    category: "owner",
  },
  async (_conn, _msg, { args, reply, isOwner, sessionId }) => {
    if (!isOwner) return (reply as (t: string) => Promise<void>)("Owner only.");

    const sub = ((args as string[])[0] || "").toLowerCase();

    if (!sub || (sub !== "on" && sub !== "off")) {
      const current = isMovieDocOn(sessionId as string) ? "ON" : "OFF";
      return (reply as (t: string) => Promise<void>)(
        `MovieDoc Status: ${current}\n\nON  = Movie poster as thumbnail\nOFF = Hard thumb always\n\nUsage: .moviedoc on / .moviedoc off`
      );
    }

    const config = getSessionConfig(sessionId as string);
    config.movieDoc = sub === "on";
    saveSessionConfig(sessionId as string, config);
    await (reply as (t: string) => Promise<void>)("MovieDoc is now " + sub.toUpperCase() + ".");
  }
);

cmd(
  {
    pattern: "setfooter",
    alias: ["botname"],
    react: "✏️",
    desc: "Set bot name used in footer",
    category: "owner",
  },
  async (_conn, _msg, { args, reply, isOwner, sessionId }) => {
    if (!isOwner) return (reply as (t: string) => Promise<void>)("Owner only.");

    const q = (args as string[]).join(" ").trim();
    if (!q) return (reply as (t: string) => Promise<void>)("Example: .setfooter Sayura MD");

    const config = getSessionConfig(sessionId as string);
    config.botName = q;
    saveSessionConfig(sessionId as string, config);
    await (reply as (t: string) => Promise<void>)("Bot name set to: " + q);
  }
);

cmd(
  {
    pattern: "setthumb",
    alias: ["thumburl"],
    react: "🖼️",
    desc: "Set default thumbnail URL",
    category: "owner",
  },
  async (_conn, _msg, { args, reply, isOwner, sessionId }) => {
    if (!isOwner) return (reply as (t: string) => Promise<void>)("Owner only.");

    const q = (args as string[]).join(" ").trim();
    if (!q) return (reply as (t: string) => Promise<void>)("Example: .setthumb https://example.com/image.jpg");
    if (!q.startsWith("http")) return (reply as (t: string) => Promise<void>)("Please provide a valid URL.");

    const config = getSessionConfig(sessionId as string);
    config.thumbUrl = q;
    saveSessionConfig(sessionId as string, config);
    await (reply as (t: string) => Promise<void>)("Hard thumb URL updated.");
  }
);
