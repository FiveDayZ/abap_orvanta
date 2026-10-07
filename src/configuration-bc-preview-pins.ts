// Pinned to live w200 sources read in r46; loader pins prove policy, never invoked.
export const configurationBcPreviewFunctions = {
  DDIF_NAMETAB_GET: {
    sourceFingerprint: "ad95bfc7831e7e5076f79ba9e85e6443c94907eb80db188ea4d35f382f43ff65",
    interfaceFingerprint: "9de8d24b9d3d8f8aa19a2fb3878832fb7dd1238c1259cebe278e2b71c28342f3",
    remoteEnabled: false,
    lineCount: 300
  },
  DD_GET_NAMETAB: {
    sourceFingerprint: "0f8df3778fb0a57b39ef67d57e8fa2f9545e247f5b80c7bf3ffd094797153d1f",
    interfaceFingerprint: "099aa393cb301050b298a847797fece6f2b01a9d0be49cec0f04372c5b49cccd",
    remoteEnabled: false,
    lineCount: 127
  },
  SCPR_CT_DECDELIM_CONVERT_ONE: {
    sourceFingerprint: "3fc1f5e03c0fbc3764b292b7ba3a94343aa09aa363b9cb27a2e6241a0a6a23ff",
    interfaceFingerprint: "c2047dae3a916d97aaacac32603052ce61bae850c9a37af96b9ff3b44b2421d0",
    remoteEnabled: false,
    lineCount: 107
  },
  RS_CONV_EX_2_IN_NO_DD: {
    sourceFingerprint: "2a31f6057d9ed394bc208305e13e4c439e43cb71d648734f9fe5d5093340d009",
    interfaceFingerprint: "5c937657853f9497ec3de103841aad8a7f125f4ff0e758a5f021879c0aeeb0c7",
    remoteEnabled: false,
    lineCount: 133
  },
  SCPR_PRSET_CT_ONE_TABLE_LOAD: {
    sourceFingerprint: "a7d73a3bcb86ad66ede551553568139222f45c29bfa1767e9d257a1d8e11cacb",
    interfaceFingerprint: "1a7fffc46553344866b70356f44c8e788c071419431c2198bb98fc642448bef4",
    remoteEnabled: false,
    lineCount: 591
  },
  SCPR_PRSET_CT_IMPORT_INDUSTRY: {
    sourceFingerprint: "add1c596768b06381f8d5023e4e6dc8c895ea76dc8b02b6c221de465e05406dd",
    interfaceFingerprint: "ae071f65d6a2ab73f69de60d0d2dc6c58281bcd1c991b1e52768633b1c6cb7bf",
    remoteEnabled: false,
    lineCount: 1205
  }
} as const
export const configurationBcPreviewIncludes = {
  LSCPRPSF02: {
    sourceUri: "/sap/bc/adt/functions/groups/scprps/includes/lscprpsf02/source/main",
    sourceFingerprint: "898394f59a01dfa05d136b5a736f9f5b76c4ac93fbd5f9967abd5bc31dee1593",
    lineCount: 636
  },
  RSDYNSS0: {
    sourceUri: "/sap/bc/adt/programs/programs/rsdynss0/source/main",
    sourceFingerprint: "139208865f9dffdbd39b1d83ed16675a8b25daa6b69946d90083245162f69e69",
    lineCount: 1508
  },
  RSDYNSC0: {
    sourceUri: "/sap/bc/adt/programs/includes/rsdynsc0/source/main",
    sourceFingerprint: "8f3761994a55dfd2ba75ff32bf83d8a4dc5f106863b11d30e653a3685ca82e48",
    lineCount: 9
  },
  LSSELFXX: {
    sourceUri: "/sap/bc/adt/functions/groups/ssel/includes/lsselfxx/source/main",
    sourceFingerprint: "5056ed158a2ba4d1254baf4b8b1aef8cfdc8aeca654893e5853162a445986993",
    lineCount: 2839
  },
  LSDIFRUNTIMEF01: {
    sourceUri: "/sap/bc/adt/functions/groups/sdifruntime/includes/lsdifruntimef01/source/main",
    sourceFingerprint: "a0298192bddc753e5abc3880906d90aa98be75a0d974acd252c194b75199b978",
    lineCount: 933
  }
} as const
export const configurationBcPreviewStructures = {
  RSCONVLITE: "f734f799b388d5aaac87cfe85604f11a3a05180ddf83fb243f90fcb7ab3a2de5",
  DFIES: "0312147abc3e59476c0dd2344eb7d38a11cd71d6ff6ec0f50170a18595525680"
} as const
