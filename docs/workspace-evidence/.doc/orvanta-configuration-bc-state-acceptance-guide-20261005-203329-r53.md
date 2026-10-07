# r53 固定原生前态验收说明

2026-10-05T20:33:29+08:00，w200/GR2/client200/WYS；当前 **Partially Verified**。

本阶段仅 EHS_CUNI_KNM/N、九表十九键、配置GR2K923429/430读取。原生STATE已激活，源码/接口已按r52候选读回；运行仅暴露read_configuration_bc_before_state。窗口51008已打开，口令只在其ASCII提示中输入；不要发送口令或导出进程环境。独立构建固定129文件，不重启共享4849或旧只读实例，不改变旧固定构建。

输入口令后server.mjs先重验manifest、用户client与STATE源/接口；只读READ/PREVIEW/ROUTE/GUARD/CTS取得当前六版本，并对STATE运行4项固定错误输入：非本BCSet、版本A、非本配置请求、无效CTS版本。预期INPUT_INVALID，其余16输出为空；任一异常保留preparation.json后停止，不自动重试。

收到ready.json后执行 node .cache/spro-r53/accept.mjs：四项公开schema拒绝必须在任何backend调用前发生；随后两个公开正例，各两次原生STATE调用。公开结果必须完全一致，返回GR2/200/WYS、九表固定scope、真实字节数与SHA256、nativeRoundtrip=true、所有执行/恢复/激活许可false。完整CTS字节/版本和19键预检均前后核对；本地不可变引用需要读回、身份/版本/字节核验，第二次捕获不新增文件、不覆盖或改时间。

验收预算：最多4次正例STATE原生命令、4次原生错误输入、4次公开schema错误输入；读取依赖按现有有界只读器完成。无BC Set激活/模拟/配置改值/配置CTS追加或清理/传输释放。任一失败保留完整回执并按原因只读核对，不自动消耗第二次正例预算。完成后停止本阶段实例，清除临时环境；仅关闭51008对应任务窗口，不关闭用户或其他实例。

原生接口不可通过现有通用执行合同绕过；使用本固定专用adapter。编译、metadata和mock均不能替代真实正例验收。
