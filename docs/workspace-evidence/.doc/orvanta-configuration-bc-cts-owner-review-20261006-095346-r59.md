# r59：标准 CTS 键检查、CICO 及补偿所有权复核

实际时间 2026-10-06T09:53:46.175+08:00（Asia/Shanghai），w200 / GR2 / client 200。状态 Review Only：本部分只读标准源码、接口及 DDIC，未执行追加、删除、注释清理或其他标准命令。完整返回结果保存在[证据 JSON](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-cts-owner-review-20261006-095346-r59.json)。

## 实际覆盖

通过 STRD 主程序的真实 include 图及 LSTRDUXX 生成映射，定位 LSTRDU32（TRINT_APPEND_TO_COMM_ARRAYS）与 LSTRDF32。完整读取 STRD 35 行、LSTRDUXX 67 行、LSTRDU32 764 行、LSTRDF32 272 行；另读取 8 个函数的完整返回源码共 1960 行。合计 3098 行是已读覆盖，不代表整个 CTS 调用图已闭合。LSTRDF50 / LSTRDF33 的先前搜索只作为定位证据，不计入完整覆盖。

LSTRDF32 的 full-source SHA-256：3bed81eee746ea5e4a8b14feccdada45ee97a2158cf1bb029d2cde088f3cd12f；LSTRDU32：7f1d83022d19137b73ffd87c898692ce256db2e980b0291bfc7f5fba53ce26c9。没有修改 SAP 标准对象。

## 已确认行为及实现约束

| 所有权点 / 实际范围 | 读取证据与行为 | 保存 / 恢复要求 |
| --- | --- | --- |
| LSTRDF32，dequeue_all，7–20 | 仅 pv_enqueue=X 时，对记录在 pt_enqueue 的对象调用 DEQUEUE_E_TLOCK | 不能把任意会话锁当成本命令持有的锁；错误路径只能释放确实取得的锁 |
| LSTRDF32，check_keys，25–124 | 要求当前输入或任务已有相同 master/ACTIVITY/LANG 且 OBJFUNC=K 的 E071；把子键 OBJFUNC 归空格，再调用 TR_REQ_CHECK_KEY；出错时按 pv_update 执行 ROLLBACK | 保存必须保留官方检查、主子键身份及固定空格；失败不能继续持久化 |
| LSTRDF32，check_keys_str，129–229 | 长键使用 E071K_STR 和 TR_REQ_CHECK_KEY_STR，仍核对主对象与语言、活动 | 不能用普通 E071K 删除函数补偿所有长键；本固定十九键仍需证明实际编码长度 |
| TR_REQ_CHECK_KEY，完整 532 行，243–305 / 367–399 / 428–449 | 检查请求 client、字段类型和语言；按 DDIC lowercase 转换；可能清空超出允许键长的尾部 | 以标准输出键作真实 CTS 身份；不能统一 uppercase 或 trim；对比前后键规范化结果 |
| LSTRDF32，set_cico_comnt，234–272 | 读取范围相交的 TLOCKCIO：COMNT 空格改 X，已有 X 保留，其他值返回错误；无错时 UPDATE TLOCKCIO FROM TABLE | 除 E071/E071K/TLOCK 外，必须识别 CICO 注释的受影响集合；不能漏报副作用 |
| TRINT_READ_CICO_LOCKS，完整 30 行 | OBJECT 相同且 HIKEY>=输入 LOKEY、LOKEY<=输入 HIKEY 的所有重叠记录；包含更大锁 | 只捕获目标精确键不足；需包含实际重叠范围及全字段、身份和版本 |
| TLOCKCIO，真实 DDIC | 主键 OBJECT / HIKEY；LOKEY、MASTER、TID、PID、COMNT、MODDATE、MODTIME 非键；表为系统锁用途、非业务配置 | 不得新增直接更新标准锁表的 MCP；若标准路线产生影响，必须按真实官方契约恢复或人工接管 |
| TRINT_DELETE_COMM_KEYS，完整 103 行，68–100 | 使用完整 TABKEY / VIEWNAME / master / ACTIVITY / LANG / OBJFUNC 身份删除 E071K，更新 E070 时间，随后 CALL FUNCTION DB_COMMIT | 不能置于声称顶层唯一 commit 的原子 RECOVER 中；必须明确不可回滚分段、回执与再对账 |
| TRINT_DELETE_COMM_OBJECT_KEYS，完整 466 行，291–365 | 删除整个 pgmid/object/name 的 E071，以及相应 master/LANG/ACTIVITY 的 E071K 与 E071K_STR，并更新 E070/SMODILOG | CUNI 主对象可能已有历史键，不能用于仅本次新增子键的精确补偿；其他 TLOCK/TADIR/项目锁/日志分支仍需可达性闭合 |
| TR_DELETE_COMM_OBJECT_KEYS，完整 100 行 | ENQUEUE_E_TRKORR、重读、调用整对象删除、DEQUEUE_E_TRKORR；默认 IV_DIALOG_FLAG=X | 不能把这个外层包装当精确键删除；无对话也不改变删除范围 |
| TR_CICO_REMOVE_COMNT，完整 70 行 | 通过 check_ojb_type / conv_objdevc_to_e071 / enq / read_all_locks / check_req_lck_before_comnt_del / remove_comnt_flag / dq 处理对象级注释 | 目前只确认存在及外层调用图，未闭合 FORM、恢复范围与提交契约，不可直接据此开放自动清理 |

## 界限及下一步

本轮将此前未定位的四个 FORM 闭合到 LSTRDF32，并确认额外 TLOCKCIO 副作用与精确删除函数的独立 DB_COMMIT。现有 CFG_BC_EFFECTS 只读候选负责四张激活链接表，不包含 CICO/CTS 恢复，因此保持 snapshot / recoveryPermit / executable=false。没有以读前态或原生 roundtrip 宣称保存、恢复已经验证。

下一阶段首先依据固定 CUNI/T 可达路径确认 lockable 条件及 TLOCKCIO 分支是否实际可达，再读取 TR_CICO_REMOVE_COMNT 所属真实 include/FORM 和 DB_COMMIT 提交契约。以实际前态生成配置十九键、八个保护键、相关 profile 四表与 CTS/CICO 效果清单；复用现有回执和不可变前态设施。

精确 CTS 补偿若必须独立提交，应明确采用可对账的分段恢复状态机：每段保存授权范围、执行结果和读回证据；失败/超时返回 failed/unknown，并只读重对账，不自动重复删除。若无法保护既有条目或 CICO 注释，保留人工接管；不能用整对象删除、直接 SQL 或省略必要标准效果绕过。

## 函数指纹

| 函数 | 行数 | 源码 SHA-256 | 接口 SHA-256 |
| --- | ---: | --- | --- |
| TR_REQ_CHECK_KEY | 532 | 7229d95e82820ea4234517932fd1204c98ecca7b2a665d179baac8c3173739c8 | ab37b317e147fc297d0500bd74def2a19def5daf616d5ec79d0bc448ccb09738 |
| TR_REQ_CHECK_KEY_STR | 586 | 40d8dc0add73b024e3a09a75fbb1637caf9a9dd1d6dbfbf7fc2fbad87ce3562f | 5d65584697fe49c0d3fc54ff9e65e3107e642bcaee9eb82d91ac8ae79526013d |
| TRINT_READ_CICO_LOCKS | 30 | 103654c48195f7bbb888633866c4bcedb7f5be774d13155d1a910b6a857534e3 | bdfa2a870e3a5eb77ef36c3de822ba137d7d2aa762eb5ce27f88245d08521bb1 |
| DEQUEUE_E_TLOCK | 73 | bb3e6aaf40530d064f279da6ac664c04c6d6dabcf006155780ccb67869938ce6 | 899ade2eb3187bb1dfc3f90e1976de2393cf7d2c2fe506c7a30dd78b64741e20 |
| TRINT_DELETE_COMM_KEYS | 103 | 4890269c4dab18d32cc8e66ec77bcc4fae8db9fd46f11f80191274b8f52e4b40 | 3632e365a859e5f14e88239d1c116635d6c50b39c42e60e0a2ef8dd27fa45408 |
| TRINT_DELETE_COMM_OBJECT_KEYS | 466 | 08fabdd637eb332bacb1274b2418af8c0f2eda90934be6f0a643cf2cea87215a | a8a9003bb7aed330459d66c8e4b71d365e85355acedc1a53cb3a8f9278fd9c53 |
| TR_DELETE_COMM_OBJECT_KEYS | 100 | 95a67336f8958a268fe1bfbbd7002d1c2259aa54c68bb4ff684d43253f25579f | 6034c678a8abaf084ef71cba18e94e4a57c819011d4c68b46608dde89ad10628 |
| TR_CICO_REMOVE_COMNT | 70 | 0ae18bfa8056b943e4e8405ed91308b6598168f12bdb66735f9574d4deea2721 | 06260853fdefa9bf03c448a2e3b811905f7d5a69c876414af7b7010dc5ea414b |
