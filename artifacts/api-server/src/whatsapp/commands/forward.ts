import { cmd } from "../command.js";
import { getContentType, type WAMessage } from "@whiskeysockets/baileys";
import { randomBytes } from "crypto";

const genMsgId = () => randomBytes(10).toString("hex").toUpperCase();

type Conn = {
  sendMessage: (jid: string, content: unknown, opts?: unknown) => Promise<unknown>;
  relayMessage: (jid: string, message: unknown, opts: { messageId: string }) => Promise<unknown>;
};

// ── null/undefined fields protobuf crash කරනවා — strip කරනවා ──
function stripNulls(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(stripNulls).filter((v) => v !== null && v !== undefined);
  }
  if (obj && typeof obj === "object") {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      clean[k] = stripNulls(v);
    }
    return clean;
  }
  return obj;
}

cmd(
  {
    pattern: "forward",
    alias: ["fw", "fwd"],
    desc: "Reply කළ message forward කිරීම (JIDs 20ක් දක්වා)",
    category: "tools",
    react: "📤",
  },
  async (conn, msg, { from, reply, quoted, args }) => {
    const replyFn = reply as (text: string) => Promise<unknown>;
    const fromJid = from as string;
    const rawMsg = msg as WAMessage;
    const sock = conn as unknown as Conn;

    // ctx.quoted is already extracted by the framework as { message, key }
    const quotedObj = quoted as { message?: Record<string, unknown> } | null;
    if (!quotedObj?.message) {
      await replyFn(
        "📤 *Forward Usage*\n\nForward කරන්නට ඕනේ message එකට *reply* කරලා *.forward* type කරන්න.\n\n" +
          "✅ Single JID: *.forward 120363382037700734@g.us*\n" +
          "✅ Multi JID (max 20): *.forward jid1,jid2,jid3*\n" +
          "✅ JID නැත්නම් current chat එකට forward වෙනවා."
      );
      return;
    }

    // ── JID list parse කරනවා (max 20) ──
    const q = ((args as string[]) ?? []).join(" ").trim();
    let targets: string[] = [];
    if (q) {
      targets = q
        .split(",")
        .map((j) => j.trim())
        .filter((j) => j.length > 0)
        .slice(0, 20);
    }
    if (!targets.length) targets = [fromJid];

    try {
      await sock.sendMessage(fromJid, { react: { text: "⏳", key: rawMsg.key } });
    } catch {
      // react failures can be ignored
    }

    try {
      let quotedContent: Record<string, unknown> = quotedObj.message;

      // View Once unwrap
      if (quotedContent["viewOnceMessageV2"]) {
        quotedContent = (quotedContent["viewOnceMessageV2"] as Record<string, unknown>)[
          "message"
        ] as Record<string, unknown>;
      } else if (quotedContent["viewOnceMessage"]) {
        quotedContent = (quotedContent["viewOnceMessage"] as Record<string, unknown>)[
          "message"
        ] as Record<string, unknown>;
      }

      // Clone + null strip — protobuf crash fix
      let messageToForward: Record<string, unknown> = stripNulls(
        JSON.parse(JSON.stringify(quotedContent))
      ) as Record<string, unknown>;

      let mType = getContentType(messageToForward as Parameters<typeof getContentType>[0]) as
        | string
        | undefined;
      if (!mType) throw new Error("Message type detect කරගන්න බැරි වුණා.");

      // conversation → extendedTextMessage
      if (mType === "conversation") {
        const text = messageToForward["conversation"];
        messageToForward = { extendedTextMessage: { text: String(text) } };
        mType = "extendedTextMessage";
      }

      // forwardingScore inject
      const inner = messageToForward[mType];
      if (inner && typeof inner === "object") {
        (inner as Record<string, unknown>)["contextInfo"] = {
          ...(((inner as Record<string, unknown>)["contextInfo"] as Record<string, unknown>) ?? {}),
          forwardingScore: 999,
          isForwarded: true,
        };
      }

      // ── සියලු JIDs වලට forward කරනවා ──
      let success = 0;
      let failed = 0;
      for (const jid of targets) {
        try {
          await sock.relayMessage(String(jid), messageToForward, { messageId: genMsgId() });
          success++;
        } catch (err) {
          console.error(`[FORWARD ERROR] ${jid}:`, (err as Error).message);
          failed++;
        }
      }

      try {
        await sock.sendMessage(fromJid, { react: { text: "✅", key: rawMsg.key } });
      } catch {
        // ignore
      }

      if (targets.length > 1) {
        await replyFn(
          `✅ *Forward සම්පූර්ණයි!*\n\n📤 *Success:* ${success}/${targets.length}\n❌ *Failed:* ${failed}`
        );
      }
    } catch (err) {
      console.error("[FORWARD ERROR]", err);
      try {
        await sock.sendMessage(fromJid, { react: { text: "❌", key: rawMsg.key } });
      } catch {
        // ignore
      }
      await replyFn(`❌ Forward failed: ${(err as Error).message}`);
    }
  }
);
