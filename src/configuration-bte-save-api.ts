// Active standard APIs read from w200 on 2026-10-07; these pins do not grant writes.
export const configurationBteSaveApiPins = {
  VIEW_MAINTENANCE_NO_DIALOG: {
    functionGroup: "SVIM",
    source: "aef8ff0659768c8c723583f7d084449063afc5980060f4c45b3c5641a499b861",
    interface: "096a143263b04e39e651e1f42a8038df2193fca019eaf41b7e34d1829d72816b",
    remoteEnabled: false,
    updateTask: false,
    updateTaskMode: "",
    globalInterface: false
  },
  VIM_SET_NO_TR_DIALOG: {
    functionGroup: "SVIM",
    source: "de7d0295c1ecd0fcd2cbf24cd3c523424b9403b09373e968c2c04dd928ebebcd",
    interface: "0a680482a5df172c6012c13132ae3095da1261e61a3d7c923a52a4f5d08b05cc",
    remoteEnabled: false,
    updateTask: false,
    updateTaskMode: "",
    globalInterface: false
  },
  VIM_TR_OBJECTS_INSERT: {
    functionGroup: "SVIM",
    source: "19d11d700879076994048dc6f56a9c62dd3df5023024e3816561a6ab924eec49",
    interface: "0e296a9b50c9040a95d1a35d1bc75119f2d54675c5960917b830ef4489aa7ef1",
    remoteEnabled: false,
    updateTask: false,
    updateTaskMode: "",
    globalInterface: false
  },
  CTS_WBO_API_INSERT_OBJECTS: {
    functionGroup: "CTS_WBO_API",
    source: "bef855925c6eeda78c4ecb0fc9b0aa557047dfe880674fb8cb0a9abb60833e21",
    interface: "a2b3d7446e0b298e19cb9cf9e7c01d52bf68c4fee8aab4d4a9091f3443499a39",
    remoteEnabled: false,
    updateTask: false,
    updateTaskMode: "",
    globalInterface: false
  },
  VIEW_ENQUEUE: {
    functionGroup: "SVIX",
    source: "ce56f559ad438819aa053b92a2e8a52452594256ca9f9632b384ba100d4e7401",
    interface: "c3b63082242aeffc4936f59412c633d5eb8c6e174353f091f2f5b146d9e41e31",
    remoteEnabled: false,
    updateTask: false,
    updateTaskMode: "",
    globalInterface: true
  },
  VIM_GET_TR_MESSAGES: {
    functionGroup: "SVIM",
    source: "6b6dc30d7c82a48ed1a3ae09e7c599acd6ec0e7f9aefffedb76166439b55eddd",
    interface: "e4b3b9abb9d0a05cc16a70f104419bf38813437c2da9dd5c22852bb41f8324d6",
    remoteEnabled: false,
    updateTask: false,
    updateTaskMode: "",
    globalInterface: false
  },
  CONTEXT_BUFFER_DELETE: {
    functionGroup: "SFRM",
    source: "98ef411b1de4441f55e39460ce9e1f83779182e139c899126962e87e5e5d994d",
    interface: "37f53fe26f450e1bc0b6ef1af5af2def4b07a9cf07c7cacaa853857ec25c3865",
    remoteEnabled: false,
    updateTask: true,
    updateTaskMode: "1",
    globalInterface: false
  }
} as const
