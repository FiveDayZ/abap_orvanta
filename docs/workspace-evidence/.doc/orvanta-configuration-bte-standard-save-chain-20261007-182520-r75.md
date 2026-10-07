# BTE 产品标准保存链实证与缺口（r75）

时间：2026-10-07T18:25:20+08:00；w200/200，ECC 7.31；Review Only（此文档的标准调用链调查）。

## 已读取的实际源码

- LBFTMCHK：完整 36 行，SHA-256 96cf0fd1f73fc00845d92f42c2b117c1e51db6c601a3c1eb3f656a872d5cf712。
- LBFTMF01：完整 619 行，SHA-256 7f57180cc94fa6cea02a7447c7213616c2dbce3c7f6facb098a45d260cbd8f54。
- LSVIMF0U：完整 206 行，SHA-256 03a0c6acfabb466adcb377803c9b51281db3dc8434b00099f2f009bd34f855fa。
- LSVIMF0X：完整 18 行，SHA-256 576d7b6f2c4198fe0f277f91aa5e3f6fd8b7c3171577cf81dfa0ae7e8f5b5df9。
- LSVIMF0Y：完整 19 行，SHA-256 a8e176f8d4e446e582b4eb8abcc9aca1a7e8a27e37b4ee8254e4fe3a8e241038。
- LSVIMF13：完整 51 行，SHA-256 a0469b901368f24237bc479bd7f1f3527b6f6804f89bbe2479827d0c734d0e4e。
- LSVIMF14：完整 413 行，SHA-256 aa529c67ef55395a1db2716b91f4bd53c3f04dc3bd954ef6585e052cbfe963b0。
- LSVIMF1S：完整 778 行，SHA-256 6a8a10d39ef87b8d5aa7613d018c1e59ed26168c564a6f8c78eabd5a2b838d8f。
- LSVIMF1W：完整 461 行，SHA-256 994add65c48e591dd54fdbcf63771195cfc1268ebf29a00b4df1fb9730a47407。
- LSVIMF1X：完整 137 行，SHA-256 18eeebb490f7c9d596b117cab5b194e9b4a88d1d8d598bb496f1d93488c584dc。
- LSVIMF20：完整 162 行，SHA-256 4adcf21c03c09c0f6c91a5e189500547fc217ff551377edd8a3eeec7bda3359a。
- LSVIMF28：完整 23 行，SHA-256 6a2879de332313edf03f58aeed2703bd8a921cbe8d629483a8b528f5464a3081。
- LSVIMFTX：完整 1494 行，SHA-256 f24bc14ca2d4c41cef8fee0b586ce6a5067669d1ce11e08485d5f54cd5454b2e。
- VIEW_MAINTENANCE_NO_DIALOG：完整 288 行，source aef8ff0659768c8c723583f7d084449063afc5980060f4c45b3c5641a499b861 / ABI 096a143263b04e39e651e1f42a8038df2193fca019eaf41b7e34d1829d72816b。
- VIEW_MAINTENANCE_LOW_LEVEL：完整 251 行，source 1aeb5c3d4610373e63188749eb9b77604a8fd8028945e5d405327e6f311be0a0 / ABI d7d7728f3a9d34a5296c194b5dc07307164789146d61bb9d2f66f833af9c3d57。
- VIEW_GET_DATA：完整 486 行，source b918ba8d8a364ed018f9a12a2d98d15dbe8272c5a478c0fc882b62d9de929851 / ABI 7c982e819b9841b5fcf26d42e78ca4a20247c4a8dc29e6fe055761562670508b。
- TR_EC_CUST_ORIG_LANG：完整 74 行，source c2eee934c9b6fb80abfebea450f5440aa53598f44705e9113cfd59d0ed546c61 / ABI 2c4ce520d467a1db3647f82627820c19cb6df6ac7e130d6bdc1079124e9cd4ef。
- VIEW_GET_CLIENT_STATE：完整 21 行，source 3dd78d247ec56cfe9675cabe1b6aa37f72a7055b80d410167198d7b3c781c59e / ABI 83e130fd19da6091636b20f559a47e48732bd2fe5e78dfbae92b5a5b852a6956。

一次 PROG 类型查找无法解析 Include；随后按真实 PROG/I 类型读取。LSVIMF135 不存在/不可读取的返回未计入覆盖，LSVIMF13 已完整读取。原始查询与源码保存在 [证据](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bte-change-preparation-evidence-20261007-182520-r75.json)。

## 实际调用及副作用

1. VIEW_MAINTENANCE_NO_DIALOG SAVE（201—211）→ BFTM 的 X_CALL_VIEWMAINTENANCE；LSVIMF0U（56—58、99、108—137）仍设置函数组 no_dialog/import 状态，再进入 VIEW_MAINTENANCE_LOW_LEVEL。
2. VIEW_MAINTENANCE_LOW_LEVEL（54—61、156—178）依 header 选择 TABLEPROC_BFTM，读写标准函数组全局状态；它不是 remote-enabled API。
3. LSVIMFTX TABLEPROC（1382—1438）在 SAVE 路径调用 PREPARE_SAVING→TABLE_DB_UPD→AFTER_SAVING，EDIT 路径会 CALL_DYNPRO。不能把默认 EDIT 当外部保存入口。
4. LSVIMF14（62—87）的 CTS 条件包括 import_mode_active 非空；因此 IMPORT_MODE=D 不能作为绕开 CTS/权限/对话的证明。
5. LSVIMF1S（392—402、525—535）向 TR_EC_CUST_ORIG_LANG 明确传 IV_DIALOG=X；另一分支（702—735）调用 VIM_TR_OBJECTS_INSERT，不能只追一种 CTS 分支。其同步器还在 668—672、737—741 调用。
6. LSVIMF13（10—32）同时处理语言文本、事件02回调及同步器；LBFTMF01（118—127）回调 CONTEXT_BUFFER_DELETE_CUS→CONTEXT_BUFFER_DELETE(CP_INFO)，共享 TCONT 时间戳不是可回滚的业务原值。

## 已确认的客户缺陷

VIEW_AUTHORITY_CHECK 显示分支 S 将 activity 设为03，GRANTED_ACTVT 只在 alternative-check 标志启用时赋值。旧客户接口把成功时的初始导出值误判为无权限。现修正为 VIEW_ACTION=S 且标准 sy-subrc/异常判定；保留 no_authority、no_clientindependent_authority、no_linedependent_authority 的拒绝，接口不变。不是扩大账户权限。

## 未闭合项

- 标准 enqueue 所有权、复用 RFC 会话中函数组 TOTAL/EXTRACT 状态初始化与清理。
- 所有语言文本 action flags 保留，原语言 CTS 检查及 VIM_TR_OBJECTS_INSERT 的无对话错误分支。
- 同步器、缓存回调、更新任务、提交/回滚以及异常后的持久化边界；未证明单提交闭包。
- 客户 SAVE/RECOVER 实现、键级 CTS、失败/未知回执的对账与恢复；未生成伪造的可执行 ABAP 候选。

本阶段完成的是实际读取与审阅包准备。没有调用标准保存、恢复、入队、业务 handler 或配置 CTS 写接口，不能称完整 SPRO 或 BTE 启停闭环已具备。
