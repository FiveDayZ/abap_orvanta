# r56：原生只读验收就绪

时间 2026-10-06T07:42:19+08:00。客户函数已激活，测试未开始；状态 Partially Verified。窗口PID46340（创建时记录）运行 .cache/start-configuration-bc-r56-recovery.ps1，人工输入 w200/200 WYS 口令，口令只在进程环境，执行结束清除。实例按133个固定文件摘要保护，manifest SHA256 70c86cb8eb791b2b3baf92592d259a5015d19fd50f23b38abed573c1d3dfdae2；无需重新编译或重新部署后再登录。

固定 EHS_CUNI_KNM/N，配置请求429/任务430，使用服务端已校验不可变前态引用。预算2正常 RCHECK、4原生拒绝（错任务、版本、STATE摘要、坏Base64）及4本地schema拒绝（w300、越界引用、外部字节、execute字段）。schema拒绝不得触达SAP；原生拒绝应只有EV_CODE非空；正常返回19个有序行证明，8现存/11缺行，前后行原生摘要相等，身份正确及证明Base64规范/摘要相符。所有执行、恢复、快照、当前状态复核、删除、CTS恢复标志仍false。

必要READ/PREVIEW/ROUTE/GUARD/CTS各最多前后2次，比较完整原生响应，保留当前数据观察范围。接口/十个标准源/九个DDIC在适配器调用前后重新读取。受控backend拒绝其他RFC/系统、参数、SQL查询、SAP源写、通用helper、CTS及GUI操作。没有激活/模拟/改配置/恢复/释放。任一未知错误停止，不重试；尚未执行的预算不算通过。

运行日志 acceptance.json / metrics.json 在本阶段 .cache/spro-r56 下，完成后生成新的不可变根.doc验收记录。旧[开发记录](C:/My/Workplace/Coding/vscode-abap/.doc/code-update-20261006-074219.md)保留。正常样例不能自动证明非零浮点或日期时间边界；未覆盖项明确保留。
