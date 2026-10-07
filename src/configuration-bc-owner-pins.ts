import { configurationBcRecordStandardPins } from "./configuration-bc-record-kernel.js"
import {
  configurationBcEffectsAllLayouts,
  configurationBcEffectsDependencies
} from "./configuration-bc-effects.js"
import { configurationBcRecoveryDependencies } from "./configuration-bc-recovery-check.js"
import { configurationBcCtsDependencies } from "./configuration-bc-cts-api.js"
import { configurationBcRouteLayouts } from "./configuration-bc-route-api.js"

// Actual w200 tool replies; direct-call pins do not attest an entire transitive call graph.
const common = {
  ...configurationBcRecordStandardPins,
  ...configurationBcRecoveryDependencies,
  ...configurationBcEffectsDependencies,
  ...configurationBcCtsDependencies
}
export const configurationBcOwnerFunctionPins: Record<
  string,
  { source: string; interface: string; remoteEnabled: boolean; updateTask: boolean }
> = {
  ...Object.fromEntries(
    Object.entries(common).map(([name, pin]) => [
      name,
      { source: pin.source, interface: pin.interface, remoteEnabled: false, updateTask: false }
    ])
  ),
  ...{
    TR_REQ_CHECK_OBJECT: {
      source: "f63a79b41344d49023eb459031f27935322cc87e8d46279fc74911f6e3cda8db",
      interface: "25fa14abfc543afcbb1cdc5595647e3e71fe9b9f6f584f921f6f27dd79cb51aa",
      remoteEnabled: false,
      updateTask: false
    },
    TR_REQ_CHECK_KEY: {
      source: "7229d95e82820ea4234517932fd1204c98ecca7b2a665d179baac8c3173739c8",
      interface: "ab37b317e147fc297d0500bd74def2a19def5daf616d5ec79d0bc448ccb09738",
      remoteEnabled: false,
      updateTask: false
    },
    TRINT_APPEND_TO_COMM_ARRAYS: {
      source: "34a6d758f83c9460821ff95a74e9565bd89b4d6b548c7ea5a9d522fbd49a7611",
      interface: "c834dc05f0a221e952fc3dec5c524c3c1b82186826a67b93819d40909f5f9fe7",
      remoteEnabled: false,
      updateTask: false
    },
    TRINT_DELETE_COMM_KEYS: {
      source: "4890269c4dab18d32cc8e66ec77bcc4fae8db9fd46f11f80191274b8f52e4b40",
      interface: "3632e365a859e5f14e88239d1c116635d6c50b39c42e60e0a2ef8dd27fa45408",
      remoteEnabled: false,
      updateTask: false
    },
    GUID_CREATE: {
      source: "2516fea41aa60f597a44deeb7467fb7c6f5b5f4426fc6a34e2f8764de2ad9ec8",
      interface: "9c2a193b87f1bead8b4ef701af043a934b15db96330bd7610d715b3bf9af8daa",
      remoteEnabled: false,
      updateTask: false
    },
    SCPR_HI_ACTLINKS_UPDATE: {
      source: "28bc168a7f7844c04668ecf49eaba5b26218be164d2bd3d1c2f782b23ce9462c",
      interface: "7861bdba142906cf16f856aa0e5860aabd3731aed7fd457abdcaa556f7641b7b",
      remoteEnabled: false,
      updateTask: false
    },
    SCPR_HI_ACTLINKS_DELETE_UPD: {
      source: "ee04981404e61a909394434f272275f4a99ef4028ad5d69fc6a80cf56789440a",
      interface: "5290c657366f429f09c4c8f9ed2fae7d1b631e43e6f53b98b98bae2cfa013a55",
      remoteEnabled: false,
      updateTask: false
    },
    SCPR_ACTIV_PROTOCOL_WRITE: {
      source: "71be29a573260efa559d3fc42f150e12f56187ae44e8569d7eeddb55656f52f7",
      interface: "d1bb8eaf7372ef2b71727bfa2389c752218313602607a7f2457f7bcd96c59e3a",
      remoteEnabled: false,
      updateTask: false
    },
    SCPR_AUTHORITY_CHECK: {
      source: "11eaa6006acfa9933f3bbb614b088587899ed2d67260da8238b15308085e2170",
      interface: "b6db12d125987322207fc075bd6df6ae465fe82a21d37fd622df69b6dbbe542d",
      remoteEnabled: false,
      updateTask: false
    },
    ENQUEUE_READ: {
      source: "3864dbe076c11ea120338345d0e275f6a662f22e4bfc1fbd8f7c765d28e28a34",
      interface: "2ddf7e0342c71c3d7658cf8e2aaf98adc30efa762da3c9d24a1bca9504097c26",
      remoteEnabled: true,
      updateTask: false
    },
    ENQUEUE_E_TABLE: {
      source: "78f1c959b16c20315776e17aa622cadd47cebc9ac93d93712d90cf1e7a808517",
      interface: "76bd7c20e487f96d8b3ddc97861863ec4cff89d90848867c9c76f3d82861aec7",
      remoteEnabled: false,
      updateTask: false
    },
    DEQUEUE_E_TABLE: {
      source: "319f85fac630b1390e72f77f44c49e77c65fcecd18dddf9a7badfbcdadf409c8",
      interface: "281a0dc40c8b9a57adcbd52d777ec53475724280aa9d5f574419e58199c5ea5b",
      remoteEnabled: false,
      updateTask: false
    },
    ENQUEUE_E_TRKORR: {
      source: "1e7e61889844a74ead568bae37d771b9a2312025f56431303db03f85b9b47c21",
      interface: "e2cdeefb8e23d072b5a4f327ae3a3e776958d123bfb6f91cd53c7dee4a3cbaa1",
      remoteEnabled: false,
      updateTask: false
    },
    DEQUEUE_E_TRKORR: {
      source: "8d2c7f2b731e4be83b069612f2c636007e3d97500cffbf748c65a423d6877b98",
      interface: "938faa32e28154d440fe3cc563ceeedd61d842f6338c62df143dc88ec773c06d",
      remoteEnabled: false,
      updateTask: false
    },
    ENQUEUE_E_SCPR: {
      source: "45377b555b21630e5d28177215f2b1819151b50ef781729f8f685adf5747f428",
      interface: "e696d4fe90bf0e9402d31625bd82b2375a30a6683514917ce7960e65039996b5",
      remoteEnabled: true,
      updateTask: false
    },
    DEQUEUE_E_SCPR: {
      source: "515a9eb37646e88546b03a56b449713093b0ece5e440617a7f07de1b9c9ee0fc",
      interface: "f3d73467e7dba59701657dc6e6fd4ddc4dc49222d21ac26da528b83e6dea552d",
      remoteEnabled: true,
      updateTask: false
    }
  }
}
export const configurationBcOwnerLayoutPins: Record<string, string> = {
  ...configurationBcEffectsAllLayouts,
  ...Object.fromEntries(
    Object.entries(configurationBcRouteLayouts).map(([name, v]) => [name, v.fingerprint])
  ),
  ...{
    SCPRACTERP: "ec92447bfd061155a649afe39131ac0272a8734cb7ecbf159ad3f940e4b21a30",
    SCPRACTR: "eee9c8994fbb082f7019d7f8f61c9f890e4652d4e55c56d27bacbb6c76ac9619",
    SCPRACTP: "7449a52bd3293c31ad419f2fd357d9974878b7a1a577406ca9f05947695946ff",
    SCPRVALS: "cb9bbce6821a09c25d775ec1bc46c19a87aa77f6455e44f5760b977f0b6979da",
    SCPRVALL: "e87e898cc060fc1d2d3355a57640a592e16640ab318ae49ba0d7427a33e5991d",
    SCDTSYNC: "7e32510ebae3ce833a91a74733f7c9720338cdd578cb9131e501e1c5636918a6",
    SCPRACPP: "1ff356ca4b41d8a6580902d47965b688296e50b98998914a36c9c4fe0e3b116a",
    SEQG3: "c2fc418cfd35d03e0b7364331ff961aee094c57b31e0745bdc0668a10ee234c7"
  }
}

export const configurationBcOwnerIncludePins: Record<string, string> = {
  LSCPRHIF01: "f8475d9603fcb7165a4e7d3115dfc30b3fa6de6350d7eae81f6be294658ad3d2",
  LSCPRHITOP: "91e0a55492d25f40f1b6c6863e1b277a25c5f2abba8d800b3d268a27aaa88ef7"
}
