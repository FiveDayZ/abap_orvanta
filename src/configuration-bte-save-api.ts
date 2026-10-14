// Active standard APIs read from w200 on 2026-10-07; these pins do not grant writes.
export const configurationBteSaveApiPins = {
  VIEW_GET_DATA: {
    functionGroup: "SVIM",
    source: "b918ba8d8a364ed018f9a12a2d98d15dbe8272c5a478c0fc882b62d9de929851",
    interface: "7c982e819b9841b5fcf26d42e78ca4a20247c4a8dc29e6fe055761562670508b",
    remoteEnabled: false,
    updateTask: false,
    updateTaskMode: "",
    globalInterface: false
  },
  VIEW_MAINTENANCE_LOW_LEVEL: {
    functionGroup: "SVIM",
    source: "1aeb5c3d4610373e63188749eb9b77604a8fd8028945e5d405327e6f311be0a0",
    interface: "d7d7728f3a9d34a5296c194b5dc07307164789146d61bb9d2f66f833af9c3d57",
    remoteEnabled: false,
    updateTask: false,
    updateTaskMode: "",
    globalInterface: false
  },
  TRINT_WBO_IMPL_INSERT_OBJECTS: {
    functionGroup: "CTS_WBO_API_IMPL",
    source: "e6f83930f2b9d5494a94f9ebff436356ac9c97c2a1265b1378485db7bf6ebc88",
    interface: "a2b3d7446e0b298e19cb9cf9e7c01d52bf68c4fee8aab4d4a9091f3443499a39",
    remoteEnabled: false,
    updateTask: false,
    updateTaskMode: "",
    globalInterface: false
  },
  TRINT_OBJECTS_CHECK_AND_INSERT: {
    functionGroup: "STRD",
    source: "f161a219078af55400247d8f9ebea5ed69983f75b2d98880aa49a7c39b5bda29",
    interface: "fcd4495ffe804e365b023af13d195c6e643aaf539e064757fdc6cd9b87853566",
    remoteEnabled: false,
    updateTask: false,
    updateTaskMode: "",
    globalInterface: false
  },
  ENQUEUE_E_TABLEE: {
    functionGroup: "/1BCDWBEN/SENQ",
    source: "d353084b583858035a6df110438e017c01320b45066406893ca2a7dcc96d55e8",
    interface: "76bd7c20e487f96d8b3ddc97861863ec4cff89d90848867c9c76f3d82861aec7",
    remoteEnabled: false,
    updateTask: false,
    updateTaskMode: "",
    globalInterface: false
  },
  DEQUEUE_E_TABLEE: {
    functionGroup: "/1BCDWBEN/SENQ",
    source: "72bbc4502998714811b7ff3f9497b741eedb169a2afb950a2897b63acbffc59e",
    interface: "281a0dc40c8b9a57adcbd52d777ec53475724280aa9d5f574419e58199c5ea5b",
    remoteEnabled: false,
    updateTask: false,
    updateTaskMode: "",
    globalInterface: false
  },
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
