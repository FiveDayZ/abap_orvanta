# r73 固定构建只读验收补充

时间 2026-10-07T16:36:48.836+08:00；总体状态 Partially Verified。此补充取代 [先前记录](C:/My/Workplace/Coding/vscode-abap/.doc/code-update-20261007-161103.md) 中“等待登录”的当前进度，不改写该时点原记录。两项只读工具已在实际 SAP 通过限定实例的公开 SDK 调用；全 SPRO/产品保存及恢复仍未完成。

## 实际调用

- inspect_configuration_bte_maintenance_route：w200/200/WYS，maxProducts=200，耗时8080ms；BF24 参数 `/*SM30 VIEWNAME=TBE24;UPDATE=X;`；TVDIR=BFTM/FIBF/0090/BASTAB=X/NEWGENER空。实际 TVIMF 为 02/CONTEXT_BUFFER_DELETE_CUS。四产品完整返回，已有 Z/Y 候选 ZFICHK、ZWMS_MM，均 AKTIV=X、RFCDS 空；没有据名字推断业务可用性。
- preview_configuration_bte_product：实际已有 ZFICHK，active=false，只读耗时5595ms。before AKTIV=X，prospective after为空，仅 AKTIV 差异；RFCDS与键保持原值。完整 Event 一条：00001025、LAND/APPLK空、ZSAMPLE_INTERFACE_00001025；Process为空，未截断。没有实际停用。
- read_function_module_interface：ZSAMPLE_INTERFACE_00001025，240ms；非 RFC，实际 SOURCE 0b4c099d937a027e3681933d2662f9d488d62c6193d55060830aa0397717e31d，ABI 5ffd446e7438047a466f9e51d82bf260c303bbf5ec68557100630100f5973976。完整接口及源保存，但未执行业务函数、未验证生效顺序/财务运行。

共16次原生 RFC_READ_TABLE，全部原生函数名受硬 allowlist 限定；29次 READ_ 元数据辅助调用，16次固定 SELECT。ADT 精确空 HTML 使用已钉定读 RFC，不把 HTML 当空数据。16个原生回包均无 fault。新工具返回 readOnly=true/executable=false/writeAvailable=false/atomicSnapshot=false，元数据在两轮数据读取前核对；不是锁内原子快照。

## 新确认的保存副作用

当前真实 TBE24 事件02确为 LBFTMF01 118–127 的 CONTEXT_BUFFER_DELETE_CUS，而非 TBE11 的 BC Set 回调。该 FORM 119–123 调用 CONTEXT_BUFFER_DELETE(CP_INFO)。本阶段进一步从 SAP 读取该 SFRM 函数的全部15行及ABI：updateTask=true，非 RFC，11–13为时间戳、14为 MODIFY TCONT。该源码证明确有持久缓存时间戳副作用；本阶段没有调用它，没有改写 TCONT。未来产品保存/恢复不得只对账 TBE24 或试图恢复旧缓存审计时间。

## 回执、退出及限制

[不可变原始实际验收](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bte-maintenance-route-acceptance-20261007-161505-r73.json) 包含公开调用、原生请求/结果、固定555文件及哈希。原固定构建未在登录后重编译；node44884退出0，临时口令环境已清除；仅本任务窗口62440已关闭，共享60128保持运行/构建不变。配置、CTS、客户/标准源写入0，不释放请求。历史 r69/r71 的失败、未知与已耗尽预算保持原状。

## 验证注册与下一步

两项公开只读工具从 unverified 改为 verified，分别限定实际 BF24 路线/清单和 ZFICHK 有数据预览；引用同一原始回执。验证注册表增加一项真实证据守卫，核对 named calls、真实元数据、产品/关联/handler、16个只读原生请求、写入标志以及口令清除。数量上限152→154仅对应这两个观察，不代表多了可写配置能力。最终34项注册表回归通过；690项既有范围回归加这1项新守卫，共691项不同测试。

下一阶段已准备 [r74 元数据 RFC 完整源/ABI 审阅包](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bte-native-meta-deployment-review-20261007-163320-r74.md)；读取完整 native 控制块后才能实现产品保存命令。标准 CTS 对话/提交、权限锁、产品文本、缓存更新、回滚/未知对账和业务触发仍未完成。
