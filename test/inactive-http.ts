import { XMLBuilder } from "fast-xml-parser"

export function inactiveHttp(read: () => unknown[] | Promise<unknown[]> = () => []) {
  return {
    async request() {
      const entries = await read()
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/xml" },
        body: new XMLBuilder({ ignoreAttributes: false }).build({
          "ioc:inactiveObjects": {
            "@_xmlns:ioc": "http://www.sap.com/adt/inactivectsobjects",
            "@_xmlns:adtcore": "http://www.sap.com/adt/core",
            "ioc:entry": entries
          }
        })
      }
    }
  }
}
