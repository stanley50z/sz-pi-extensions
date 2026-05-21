// extensions/sz-git-view/server.ts
import { createServer, IncomingMessage, Server } from "node:http";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";

interface WsSocket extends Socket {
  _wsAlive?: boolean;
}

interface GitViewServer {
  start(htmlTemplate: string): Promise<number>;
  stop(): void;
  broadcast(data: object): void;
  onMessage: ((type: string, payload: any) => void) | null;
  get clientCount(): number;
}

export function createGitViewServer(): GitViewServer {
  let httpServer: Server | null = null;
  let clients: Set<WsSocket> = new Set();
  let onMessageCb: ((type: string, payload: any) => void) | null = null;
  let template = "";

  function handleUpgrade(req: IncomingMessage, socket: WsSocket, head: Buffer) {
    const key = req.headers["sec-websocket-key"];
    if (!key) { socket.destroy(); return; }

    const accept = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    socket._wsAlive = true;
    clients.add(socket);

    let buffer = Buffer.alloc(0);

    socket.on("data", (buf: Buffer) => {
      buffer = Buffer.concat([buffer, buf]);

      // Try to parse complete frames from the buffer
      const { frame, remaining } = decodeWsFrame(buffer);
      if (frame !== null) {
        try {
          const parsed = JSON.parse(frame);
          onMessageCb?.(parsed.type, parsed.payload);
        } catch { /* ignore malformed messages */ }
        buffer = remaining || Buffer.alloc(0);
      }
    });

    socket.on("close", () => {
      clients.delete(socket);
    });

    socket.on("error", () => {
      clients.delete(socket);
    });
  }

  function encodeWsFrame(data: string): Buffer {
    const payload = Buffer.from(data, "utf-8");
    const len = payload.length;
    if (len < 126) {
      return Buffer.concat([Buffer.from([0x81, len]), payload]);
    } else if (len < 65536) {
      const buf = Buffer.alloc(4);
      buf[0] = 0x81;
      buf[1] = 126;
      buf.writeUInt16BE(len, 2);
      return Buffer.concat([buf, payload]);
    } else {
      const buf = Buffer.alloc(10);
      buf[0] = 0x81;
      buf[1] = 127;
      buf.writeBigUInt64BE(BigInt(len), 2);
      return Buffer.concat([buf, payload]);
    }
  }

  function decodeWsFrame(buf: Buffer): { frame: string | null; remaining: Buffer | null } {
    if (buf.length < 2) return { frame: null, remaining: buf };

    const opcode = buf[0] & 0x0f;
    if (opcode === 0x8) return { frame: null, remaining: buf }; // close — discard
    if (opcode === 0x9) return { frame: null, remaining: buf }; // ping — ignore for now
    if (opcode !== 0x1 && opcode !== 0x2) return { frame: null, remaining: buf };

    const masked = (buf[1] & 0x80) !== 0;
    let payloadLen = buf[1] & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (buf.length < 4) return { frame: null, remaining: buf };
      payloadLen = buf.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      if (buf.length < 10) return { frame: null, remaining: buf };
      payloadLen = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }

    const totalLen = offset + (masked ? 4 : 0) + payloadLen;
    if (buf.length < totalLen) return { frame: null, remaining: buf };

    let data: Buffer;
    if (masked) {
      const mask = buf.slice(offset, offset + 4);
      const payload = buf.slice(offset + 4, offset + 4 + payloadLen);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      data = payload;
    } else {
      data = buf.slice(offset, offset + payloadLen);
    }

    const remaining = buf.length > totalLen ? buf.slice(totalLen) : null;
    return { frame: data.toString("utf-8"), remaining };
  }

  return {
    start(htmlTemplate: string): Promise<number> {
      template = htmlTemplate;
      return new Promise((resolve, reject) => {
        const tryPort = (attempt: number) => {
          const port = 61589 + attempt;

          httpServer = createServer((_req, res) => {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(template);
          });

          httpServer.on("upgrade", handleUpgrade);

          httpServer.on("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE") {
              if (attempt < 10) return tryPort(attempt + 1);
              return reject(new Error("No available port in range 61589-61598"));
            }
            reject(err);
          });

          httpServer.listen(port, "127.0.0.1", () => resolve(port));
        };

        tryPort(0);
      });
    },

    stop() {
      for (const client of clients) {
        try { client.destroy(); } catch { /* ignore */ }
      }
      clients.clear();
      httpServer?.close();
      httpServer = null;
    },

    broadcast(data: object) {
      const frame = encodeWsFrame(JSON.stringify(data));
      for (const client of clients) {
        try { client.write(frame); } catch { clients.delete(client); }
      }
    },

    get onMessage() { return onMessageCb; },
    set onMessage(cb: ((type: string, payload: any) => void) | null) { onMessageCb = cb; },

    get clientCount() { return clients.size; },
  };
}
