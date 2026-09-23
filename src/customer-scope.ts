/**
 * The customer scope this service build is bound to.
 *
 * ORVANTA is shipped as a product, but these identifiers are one specific SAP landscape, not
 * neutral defaults: connection `w200`, and the package-position table `ZTPMC_BZWL` read for plant
 * `809P` through `Z_ORVANTA_MCP_QUERY_API`. They are collected here so that "this deployment
 * serves exactly this customer scope" is one reviewable statement instead of literals spread over
 * the service, which is how R-10 found them.
 *
 * Adapting the service to another landscape is a **deployment change, not a configuration
 * toggle**. Every value below feeds a contract whose shape was established from a concrete DDIC
 * object or ADT response:
 *
 * - the connection id is a `z.literal` in `configuration-preview.ts`, so a different connection
 *   does not merely change a default - it changes the tool contract;
 * - the table, plant field and plant value define a *finite* SQL grammar in `scoped-query.ts` that
 *   exists solely to work around the observed empty-HTML data-preview response on this system.
 *
 * Change them only together with the objects they name, and re-run the acceptance that produced
 * the fingerprints in `configuration-preview.ts`. Widening the grammar to arbitrary SQL is not an
 * acceptable way to generalise the scoped fallback.
 */

/** Connection id for the landscape this build was validated against. */
export const CUSTOMER_CONNECTION_ID = "w200" as const

/** Client of that landscape; the scoped fallback and the preview both pin it. */
export const CUSTOMER_CLIENT = "200"

/** Table the scoped read fallback is allowed to read. */
export const SCOPED_QUERY_TABLE = "ZTPMC_BZWL"

/** Plant field the scoped grammar requires as its single predicate. */
export const SCOPED_QUERY_PLANT_FIELD = "WERKS"

/** Plant value the scoped grammar requires; a different plant keeps the native error. */
export const SCOPED_QUERY_PLANT = "809P"

/** SAP helper function module that performs the scoped read. */
export const SCOPED_QUERY_HELPER = "Z_ORVANTA_MCP_QUERY_API"

/**
 * Fields the scoped grammar may select. Deliberately a plain `string[]`: the membership check
 * compares arbitrary caller-supplied identifiers against it, and a literal union would make that
 * comparison a type error rather than a runtime refusal.
 */
export const SCOPED_QUERY_FIELDS: string[] = [
  "MANDT",
  "WERKS",
  "ZPOSNR",
  "ZPKGMATNR",
  "ZPKGTYPE",
  "ZPKGDESC"
]
