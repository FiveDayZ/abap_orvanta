# r54：API-only BC Set 标准命令与恢复路线

2026-10-05T20:33:29+08:00，承接r53。整体SPRO未完成；沿用用户已授权的本地实现和AI测试范围，新的SAP客户对象、配置/CTS改值和释放分别沿用具体授权边界。

## 目标与最小交付

1. 先完成r53现已激活STATE的窗口登录后只读验收。真实原生往返、配置/CTS/布局绑定与不可变引用通过后才作为写桥输入；不将r52mock或r53诊断当运行完成。
2. 在当前完整源/接口基础上形成固定 EHS_CUNI_KNM/N 九表十九键标准APPLY客户桥完整候选、RECONCILE和RECOVER契约，继续复用WriteOperationReceiptStore、前态引用和现有读器，不另建通用workflow或任意标准表SQL写入口。本地候选/回归先完成，SAP部署和配置写分别按具体审阅申请。
3. 最小可审阅候选必须闭合：SCPRACTOPT全部实际字段及选项、生产限制与权限、BCSet锁与九表/共享PRESS/CTS键锁、锁内前态/版本再读、键级标准CTS、FRAME全局收集清理/LOCAL_START/DB_COMMIT、SCDC_GET_WORKPLACE实际写及remote条件、独立R/3*协议、update-task/ON COMMIT/ROLLBACK、异常/UUID/ABAP memory清理和超时。不能证明全局rollback时明确阶段化提交与未知接管，不能虚构原子事务。
4. 形成具体APPLY配置变更及完整恢复审阅包：当前十九键差异逐行清单、共享影响、准确配置请求429/430状态与键、原生/配置/CTS/日志/分发执行预算、回读成功条件、timeout接管及补偿动作，不复用旧KG/号码范围或历史激活写预算。未批准前关闭执行/恢复入口，传输不释放。

## 验收条件

- 已绑定的原生前态只能由认证用户和当前布局解释；错用户/client/版本/来源/引用、重复或过期operationId、锁冲突均在标准维护前拒绝。
- 一次批准写的成功证据覆盖19键、准确完整CTS录制、8保护键、共享PRESS、释放锁、协议及独立效果；不可只看到目标值相等。
- 缺字段/原值初始/FLTP/日期/缺行创建/语言键、失败、权限、并发、超时和断电各有对应实际证据；未知不能重放，也不能因当前值等于before推断历史未写。恢复是单独命令，指定原生引用及许可，不接收任意SQL或外部恢复字节。

## 当前依赖与阻塞

- r53新实例手工登录及实际前态验收；ATC GET当前404，保留not_evaluated。
- 实际读取的SCPR_SV_ENQUEUE_BCSET/DEQUEUE_BCSET只委托ENQUEUE/DEQUEUE_E_SCPR；不足以证明配置行/CTS锁。
- 既有SCPR_ACTIV_MN_ACTIVATE、SCPR_ACTIV_MN_REMOTE_SUB、FRAME→LOCAL_START、独立协议与SCDC链已完整读源；NO_COMMIT不是全链路无提交保证，不能跳过这些效果。下一阶段按准确owner例程继续定向读源/DDIC，完整候选关闭所有非headless分支才申请执行。
- CFG-06双方稳定键/漂移和单侧失败，CFG-07业务规则激活与触发，CFG-08明确所选领域需求仍保留独立最小交付和验收，不以BC Set工作覆盖所有SPRO。

## 交付顺序

r53真实只读验收 → 标准API命令/补偿候选与本地拒绝/未知/兼容测试 → 精确客户桥部署审阅 → 具体配置/CTS/独立效果预算审批 → 有界真实改值、回读、恢复及失败验收。每个检查点主动更新完整backlog进度与下一阶段计划，直到所有适用要求有证据。
