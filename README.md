# 雅思听读教练站

正式网址：**https://tdzr-lyh.github.io/ielts-coach/**。邮箱注册、登录及账号云端学习记录已启用。

独立于原听力练习书的30天训练网站。用户用自己的学术类《剑桥雅思》纸书和正版配套音频做题，网站提供每日任务、方法、计时、成绩记录与复盘，不收录真题全文或音频。3.5到6.5是训练目标，结果以未做过的完整真题首次成绩和正式考试为准。

## 本地预览

从上一级“雅思”工作目录运行：

```powershell
python -m http.server 5174 -d ielts-coach
```

打开 http://localhost:5174 。JavaScript使用ES模块，应通过HTTP访问，不能直接双击HTML。手机使用需部署至HTTPS网址。

首页从“今日训练”开始，顶部可自由选择当天阅读或听力，训练单也能选择词汇和小结；不需要先做完阅读才能做听力。各项分别保存答案、用时与批改阶段，刷新后恢复所选任务，已完成科目可以回看。当天四项都完成后进入下一天；“30天路线”可预览后续安排，“训练方法”说明各题型怎么做，“错题复习”按到期日回练，“学习记录”查看首次成绩、用时并导出备份。

## 一次性开启跨设备同步

1. 在 `cloud-config.js` 对应的 Supabase 项目 SQL Editor 执行本站的 `supabase-setup.sql`。
2. 确认 Authentication 的 Email provider 已开启。到 Authentication → URL Configuration → Redirect URLs 添加 `https://tdzr-lyh.github.io/ielts-coach/`；本地测试需要时另加 `http://localhost:5174/`。不要修改共享项目原有的 Site URL，也不要删除旧听力站的回跳地址。
3. 使用真实邮箱和密码在本站注册或登录。手机和电脑使用相同邮箱，即可同步本站的学习记录。本站不使用旧听力书的账号名转内部邮箱规则。

若启用确认邮件，注册请求会显式指定当前网站目录为 `emailRedirectTo`，不携带页面查询参数或导航片段。邮件确认后回到本站主页，SDK自动处理登录会话。Supabase必须允许该完整地址（包括末尾 `/`）；否则可能退回全局 Site URL。开发预览不会硬编码生产域名。

公开配置文件只含项目URL和anon/public客户端key，不能填写 `service_role` key。当前配置复用了已有Supabase项目，但学习表 `ielts_coach_states`、浏览器登录存储和离线缓存均独立，原站 `learning_states` 不受影响。本项目的建表脚本已由管理员执行，真实账号保存、独立会话读取、账号隔离与CAS冲突保护已验证。将来迁移到新Supabase项目时，仍需执行一次脚本。

数据库不允许客户端直接写表。所有写入通过 `save_ielts_coach_state` RPC比较版本后执行：云端版本已变化时保留此设备草稿，让用户选择保留本机或使用云端，不静默覆盖。断网时草稿按用户ID缓存在本机，重新联网先读取云端版本，再尝试同步。云端未初始化会明确提示，仍可本机记录和导出备份。

未登录记录与账号记录分开；切换邮箱不会自动搬运上一账号的学习数据。退出登录保留该账号未同步草稿，重新登录该账号后继续处理。两个设备同时更改后，冲突需要手动选择，本站不做逐字段合并。

## 构建与部署

```powershell
python ielts-coach/build_deploy.py
```

生成 `ielts-coach/dist/` 与 `ielts-coach/雅思听读教练站.zip`。可将部署包上传到独立的Cloudflare Pages项目；GitHub Pages采用独立仓库 `tdzr-lyh/ielts-coach`，预期地址为 `https://tdzr-lyh.github.io/ielts-coach/`，以实际发布结果为准。

独立仓库发布步骤：

1. 把本目录源码作为新仓库根目录，包含 `tests/`、`package.json`、`VALIDATION.md` 和 `build_deploy.py`，不提交 `dist/`、部署ZIP或父目录旧站源码。
2. 将本站 `deployment/pages.yml` 模板复制为**新仓库**的 `.github/workflows/pages.yml`。模板在当前 `deployment/` 位置不会自动运行，不要复制到旧站根目录的工作流中。
3. 在新仓库 Settings → Pages 选择 GitHub Actions；可选配置下述公开客户端变量，然后推送 `main`。工作流先运行测试，再构建并发布 `dist/`。
4. 验证正式URL、资源加载、邮箱确认回跳和手机安装；完成上节SQL初始化后，再验证两个设备登录同一邮箱能读取同一份学习记录。

原目录的部署脚本和GitHub Pages工作流只发布旧听力站，不会自动发布本站。同一个GitHub仓库的两个Pages流程会覆盖彼此，不能用于发布两个独立网站。本站相对路径支持仓库子路径；分享网址请保留末尾 `/`。旧站有覆盖子目录的Service Worker，不把本站部署在旧 `/IELTS/` 路径下面。

新部署可设置成对的环境变量 `IELTS_COACH_SUPABASE_URL`、`IELTS_COACH_SUPABASE_ANON_KEY`；也支持标准 `SUPABASE_URL`、`SUPABASE_ANON_KEY`。专用变量优先，构建只修改产物里的配置。没有设置环境变量时保留本站源配置，不读取父目录配置，也不继承另一仓库的变量。

网站无后端服务器进程依赖；跨设备数据由Supabase保存。离线缓存只保存本站界面，不缓存登录/API流量。升级时修改本站Service Worker缓存版本，旧听力站缓存不受影响。

在本站目录或新仓库根目录运行 `npm test` 可执行课程模型与云同步测试。浏览器验收范围和真实云端待验收项目见 `VALIDATION.md`。

## 训练计时

阅读完整模考为60分钟，包含作答。机考听力按配套真题原速播放一次，结束后只留2分钟核对；不使用纸笔考试的10分钟誊写。精听、暂停、重播与听写属于复盘阶段，其成绩不能混入首次模考分数。每组只记录实际题量，重做成绩与首次成绩分开。

专项训练切换前结算本组计时，各科答案互不覆盖。完整阅读和听力末尾2分钟核对使用原有绝对截止时间，切换科目或刷新不能延长考试；听力音频仍须原速连续播放。

## 云层接口

`cloud.js` 导出 `CloudSync`。构造参数为 `onAuth(user|null)`、`onStatus(kind,message)`、`onRemote(state,revision)`、`onConflict({local,remote,revision})`；回调中收到的状态为副本。

- `init()`、`signIn(email,password)` 返回 `{ user, state?, revision? }`，冲突时另有 `conflict: true`。首次空账号不产生空对象覆盖，不自动上传应用默认状态。
- `signUp(email,password)` 返回 `{ confirmationRequired }`；无需确认时自动进入该账号。
- `stage(state)` 同步持久化账号草稿，不发网络请求，供输入与刷新前保存使用。
- `save(state)` 先持久化该用户草稿再同步；没有登录时返回 `localOnly: true`，访客保存由应用层处理。
- `pull()` 检查云端版本；`resolveConflict("local"|"remote")` 显式解决冲突；`signOut()` 仅退出本设备。
- `user` 为当前用户，`configured` 表示配置和SDK是否就绪。

应用须在 `onAuth` 切换时先加载对应账号的本机状态，不能将上一账号内存中的记录传给新账号。`onRemote` 更新应用本机记录时不要再次无条件调用 `save`。后台同步失败通过 `onStatus` 通知并保留草稿；登录与注册失败会抛出认证错误供界面显示。同步状态值为 `local`、`signed-out`、`syncing`、`ready`、`pending`、`offline`、`error`、`conflict`。
