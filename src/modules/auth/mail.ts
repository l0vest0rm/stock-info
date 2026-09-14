import { connect } from "cloudflare:sockets";
import type { Bindings } from "../../types";
import { bytesToBase64 } from "./crypto";
const encoder = new TextEncoder();

class SmtpClient {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(private readonly socket: ReturnType<typeof connect>) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  async expect(): Promise<void> {
    let response = "";
    for (;;) {
      const complete = this.buffer.match(/(?:^|\r?\n)(\d{3}) ([^\r\n]*)\r?\n/);
      if (complete) {
        const end = (complete.index || 0) + complete[0].length;
        response += this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end);
        if (complete[1][0] !== "2" && complete[1][0] !== "3") throw new Error(`SMTP rejected command: ${complete[1]}`);
        return;
      }
      const chunk = await this.reader.read();
      if (chunk.done) throw new Error("SMTP closed connection");
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  async command(value: string): Promise<void> {
    await this.writer.write(encoder.encode(`${value}\r\n`));
    await this.expect();
  }

  async close(): Promise<void> {
    try { await this.writer.close(); } catch { /* socket already closed */ }
    this.reader.releaseLock();
    this.writer.releaseLock();
    await this.socket.close();
  }
}

function smtpSafe(value: string): string {
  return value.replace(/[\r\n]/g, " ").trim();
}

export async function sendResetEmail(env: Bindings, recipient: string, token: string): Promise<void> {
  const host = env.MAIL_SMTP_HOST;
  const username = env.MAIL_SMTP_USERNAME;
  const password = env.MAIL_SMTP_PASSWORD;
  const from = env.MAIL_FROM_EMAIL;
  if (!host || !username || !password || !from) throw new Error("SMTP is not configured");
  const port = Number(env.MAIL_SMTP_PORT || "465");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid SMTP port");
  const socket = connect({ hostname: host, port }, { secureTransport: "on", allowHalfOpen: false });
  const smtp = new SmtpClient(socket);
  const timeout = setTimeout(() => { void socket.close().catch(() => {}); }, 15_000);
  try {
    await smtp.expect();
    await smtp.command("EHLO tinfo.cc");
    await smtp.command("AUTH LOGIN");
    await smtp.command(bytesToBase64(encoder.encode(username)));
    await smtp.command(bytesToBase64(encoder.encode(password)));
    await smtp.command(`MAIL FROM:<${smtpSafe(from)}>`);
    await smtp.command(`RCPT TO:<${smtpSafe(recipient)}>`);
    await smtp.command("DATA");
    const displayName = smtpSafe(env.MAIL_FROM_NAME || "TINFO.CC");
    const message = [
      `From: ${displayName} <${smtpSafe(from)}>`,
      `To: <${smtpSafe(recipient)}>`,
      `Subject: =?UTF-8?B?${bytesToBase64(encoder.encode("TINFO.CC 密码重置链接"))}?=`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "请打开以下链接设置新密码：",
      `${env.APP_RUNTIME === "node" ? "http://127.0.0.1:8000" : "https://tinfo.cc"}/login.html#reset-password/${token}`,
      "链接 10 分钟内有效且只能使用一次。如非本人操作，请忽略此邮件。",
      ".",
    ].join("\r\n");
    await smtp.command(message);
    await smtp.command("QUIT");
  } finally {
    clearTimeout(timeout);
    await smtp.close();
  }
}

