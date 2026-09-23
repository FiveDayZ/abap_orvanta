import type { Server } from "node:http"
import { isFetchBlockedPort } from "../src/http.js"

/**
 * Bind `server` to an ephemeral loopback port that Node's fetch/undici will actually talk to.
 *
 * `listen(0)` draws from the Windows dynamic port range, which on this machine starts at 1024 and
 * therefore overlaps undici's bad-port blocklist. A test that binds port 0 and then fetches can
 * therefore fail intermittently through no fault of the code under test, so every such bind goes
 * through here instead.
 */
export async function listenOnUnblockedPort(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 64; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      server.once("error", onError)
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError)
        const address = server.address()
        if (!address || typeof address === "string") {
          reject(new Error("the server did not report a TCP port"))
          return
        }
        resolve(address.port)
      })
    })
    if (!isFetchBlockedPort(port)) return port
    await new Promise<void>((done) => server.close(() => done()))
  }
  throw new Error("could not obtain a loopback port outside the fetch bad-port blocklist")
}
