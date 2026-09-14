import { connect as tlsConnect } from "node:tls";
import { Readable, Writable } from "node:stream";

/** Node build replacement for the Worker's TLS socket transport. */
export function connect(address: { hostname: string; port: number }, options: { secureTransport: string; allowHalfOpen?: boolean }) {
  if (options.secureTransport !== "on") throw new Error("SMTP requires TLS");
  const socket = tlsConnect({ host: address.hostname, port: address.port, servername: address.hostname, rejectUnauthorized: true });
  socket.setTimeout(15_000, () => socket.destroy(new Error("SMTP timed out")));
  return {
    readable: Readable.toWeb(socket),
    writable: Writable.toWeb(socket),
    async close() { socket.destroy(); },
  };
}
