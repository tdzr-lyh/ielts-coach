import { DAYS, METHODS, LISTENING_BLOCKS, LISTENING_REFERENCES } from './curriculum.js';
import {
  createState, normalizeState, dateKey, tasksForDay, getSelectedTask, selectTask,
  questionsFor, resolveTask, startAttempt, beginSelfCheck, setExternalDuration, finishAttempt, completeTask,
  dueReviews, recordReview, getAdaptation, isFreshFullAttempt, setExposure,
  subjectProgress, claimTask, getClaimedTasks,
} from './model.js';
import { CloudSync } from './cloud.js';

const $ = (s, root = document) => root.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone = v => JSON.parse(JSON.stringify(v));
const subjectName = s => s === 'reading' ? '阅读' : '听力';
const kindName = k => ({practice:'专项练习',diagnostic:'阶段诊断',mock:'完整模考',analysis:'精读 / 精听',review:'错题重练',wrapup:'考前巩固'}[k] || '学习任务');
const PREFIX = 'ielts-coach-state-v1:';
const runtime = { user:null, view:'today', methodFilter:'all', reviewFilter:'due', routeSubject:'listening', focusAttempt:null, saveTimer:null, toastTimer:null, authMode:'login', conflict:null };
let state = readLocal('guest');

function readLocal(id) {
  try { return normalizeState(JSON.parse(localStorage.getItem(PREFIX + id))); }
  catch { return createState(); }
}
function writeLocal() {
  try { localStorage.setItem(PREFIX + (runtime.user?.id || 'guest'), JSON.stringify(state)); }
  catch { toast('本机存储空间不足，请到学习记录导出备份。'); }
}
function persist(sync = true) {
  writeLocal();
  if (sync && runtime.user) Promise.resolve(cloud.save(clone(state))).catch(e => toast(e.message || '云端保存失败，本机记录已保留。'));
}
function saveSoon() {
  writeLocal(); clearTimeout(runtime.saveTimer);
  if (runtime.user) cloud.stage(clone(state));
  runtime.saveTimer = setTimeout(() => persist(), 650);
}
function toast(message) {
  const el = $('#toast'); el.textContent = message; el.hidden = false;
  clearTimeout(runtime.toastTimer); runtime.toastTimer = setTimeout(() => el.hidden = true, 4500);
}
function setSync(kind, message) {
  $('#syncDot').className = `status-dot ${kind === 'ready' || kind === 'synced' ? 'ready' : /error|conflict/.test(kind) ? 'error' : ''}`;
  $('#syncLabel').textContent = ({ready:'已同步',synced:'已同步',syncing:'正在同步',pending:'待同步',offline:'离线保存',error:'同步待处理',conflict:'版本待确认',unconfigured:'本机保存'}[kind] || (runtime.user ? '云端连接' : '本机保存'));
  $('#syncLabel').title = message || kind;
  const notice = $('#cloudNotice');
  notice.hidden = !['error','offline','conflict'].includes(kind) || !runtime.user;
  notice.textContent = message || '';
  if (kind === 'error' && /初始化|setup|配置/.test(message || '')) {
    notice.innerHTML = '账号已登录，云端学习记录尚未就绪；本机草稿已保留。 <button class="text-button" data-action="cloud-help">查看一次性设置步骤 →</button>';
  }
}
const cloud = new CloudSync({
  onStatus: setSync,
  onAuth(user) {
     clearTimeout(runtime.saveTimer); runtime.user = user; runtime.focusAttempt = null;
    state = readLocal(user?.id || 'guest'); render();
  },
  onRemote(remote) {
    if (!remote) return;
     state = normalizeState(remote); runtime.focusAttempt = null; writeLocal(); render();
  },
  onConflict(conflict) {
    runtime.conflict = conflict;
    openModal(`<h2>另一台设备也更新了记录</h2><p>本机草稿已保留。先选择要继续使用的版本，避免相互覆盖。</p><div class="banner">本机：${countSummary(conflict.local)}<br>云端：${countSummary(conflict.remote)}</div><div class="button-row"><button class="button" data-action="conflict-remote">使用云端版本</button><button class="button secondary" data-action="conflict-local">保留并上传本机版本</button></div><button class="text-button" data-action="export" style="margin-top:18px">先导出本机备份</button>`);
  },
});
function countSummary(s) { return `${Object.keys(s?.completed || {}).filter(id=>/^d\d+-(reading|listening)$/.test(id)).length}组任务完成，${(s?.attempts || []).filter(a => a.completedAt).length}次成绩记录`; }

function fmtTime(seconds) {
  const n = Math.max(0, Math.floor(seconds || 0)); return `${String(Math.floor(n / 60)).padStart(2,'0')}:${String(n % 60).padStart(2,'0')}`;
}
function completedAttempt(taskId) { return [...state.attempts].reverse().find(a => a.taskId === taskId && a.completedAt); }
function activeAttempt(task) {
  if (runtime.focusAttempt) {
    const found = state.attempts.find(a => a.id === runtime.focusAttempt);
    if (found?.taskId === task.id) return found;
  }
  return [...state.attempts].reverse().find(a => a.taskId === task.id && !a.completedAt);
}
function resourcesHtml(task) {
  return (task.resources || []).map(r => `<div class="resource"><span class="book-icon" aria-hidden="true">${r.book}</span><div><strong>剑桥雅思 ${r.book} · Test ${r.test}</strong><small>${r.unit ? `${task.type === 'listening' ? 'Listening Part' : 'Reading Passage'} ${r.unit}` : r.from===1&&r.to===40 ? `${subjectName(task.type)}完整试卷 · 40题` : `${subjectName(task.type)}错题重练 · 请按题号翻阅`}</small></div><span class="resource-q">Q${r.from}–${r.to}</span></div>`).join('');
}
function guideHtml(method, short = false) {
  const steps = method?.steps || ['先准备教材和纸笔。','完成练习后记录结果，并写下最需要解决的问题。'];
  return `<ol class="step-guide">${steps.slice(0, short ? 4 : steps.length).map(s => `<li><span>${esc(s)}</span></li>`).join('')}</ol>`;
}
function head(title, description, overline = 'YOUR PRACTICE DESK') {
  return `<div class="page-heading"><div><div class="overline">${overline}</div><h1>${title}</h1><p>${description}</p></div></div>`;
}
function render() {
  let recovered = false;
  for (const a of state.attempts) {
    if (!a.completedAt && a.recordingMode !== 'self-check') { beginSelfCheck(state,a.id); recovered = true; }
  }
  if (recovered) persist();
  const route = location.hash.slice(1).split('?')[0];
  runtime.view = ['today','roadmap','methods','reviews','records'].includes(route) ? route : 'today';
  const labels = {today:'任务大厅',roadmap:'训练路线',methods:'训练方法',reviews:'错题复习',records:'学习记录'};
  $('#breadcrumb').innerHTML = `我的学习空间 <span>/</span> ${labels[runtime.view]}`;
  $('#todayDate').textContent = new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'long'}).format(new Date());
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === runtime.view));
  $('#accountLabel').textContent = runtime.user ? (runtime.user.email?.split('@')[0] || '我的账号') : '登录同步进度';
  $('#avatar').textContent = runtime.user ? (runtime.user.email?.[0] || '我').toUpperCase() : '我';
  const due = dueReviews(state); $('#reviewBadge').textContent = due.length; $('#reviewBadge').hidden = !due.length;
  $('#main').innerHTML = ({today:renderToday,roadmap:renderRoadmap,methods:renderMethods,reviews:renderReviews,records:renderRecords}[runtime.view])();
}
function renderToday() {
  const selected = getSelectedTask(state);
  const focus = runtime.focusAttempt ? state.attempts.find(a=>a.id===runtime.focusAttempt) : selected ? activeAttempt(selected) || (state.completed[selected.id] ? completedAttempt(selected.id) : null) : null;
  const original = focus ? tasksForDay(state,focus.day).find(t=>t.id===focus.taskId) : selected;
  const task = original ? resolveTask(state,original) : null;
  const actual = task && focus ? {...task,...focus,id:task.id,type:focus.subject,resources:focus.resources} : task;
  const welcome = head('领取一组任务，按自己的节奏练。','阅读、听力各自推进。一次专注一组，做完再领；随时暂停，下次接着练。');
  const cards = renderSubjectPicker(actual);
  if (!actual) {
    const done = ['reading','listening'].reduce((sum,subject)=>sum+subjectProgress(state,subject).completed,0);
    return `${welcome}${cards}<section class="paper claim-empty"><span class="pill">按题型循序练习</span><h2>${done===60?'本轮听读任务已完成':done?'休息一下，再决定领哪一组':'先选一科，领取你的第一组任务'}</h2><p>${done===60?'回看完整新卷表现和反复错题，判断下一步需要补强的能力。':'任务包含教材位置、训练方法、建议用时和完成要求。你在自己的做题网站作答，回来只标对错。'}</p><p>每科30组，30天是冲刺参考。领取多少由你安排，网站不按日历堆作业。</p><a class="text-button" href="${done===60?'#records':'#roadmap'}">${done===60?'查看学习记录':'看看训练路线'} →</a></section>`;
  }
  const method = METHODS[actual.methodId];
  return `${welcome}${cards}<div class="dashboard"><article class="paper lesson"><header class="lesson-top"><div class="lesson-id"><span class="lesson-day">${String(actual.day).padStart(2,'0')}</span><div><small>${subjectName(actual.type)} · 第${actual.day} / 30组</small><strong>${esc(listeningBlock(actual)?.title || '循序训练')}</strong></div></div><span class="pill">建议 ${actual.minutes} min</span></header>${focus ? renderAttempt(actual,focus) : ['practice','diagnostic','mock','review'].includes(actual.kind) && questionsFor(actual).length ? renderTaskIntro(actual,method) : renderGeneral(actual)}</article>${renderAside(actual)}</div>`;
}
function taskStatus(task) {
  if (state.completed[task.id]) return '已完成 · 可回看';
  const attempt = [...state.attempts].reverse().find(a=>a.taskId===task.id && !a.completedAt);
  return attempt ? '继续标对错' : state.taskNotes[task.id]?.text ? '继续复盘' : '未开始';
}
function renderSubjectPicker(currentTask) {
  return `<section class="claim-grid" aria-label="领取阅读或听力任务">${['reading','listening'].map(subject=>{
    const progress = subjectProgress(state,subject), next = progress.activeTask || progress.nextTask;
    const isActive = next && next.id === currentTask?.id;
    return `<article class="paper claim-card ${isActive?'is-selected':''}"><div class="side-title"><h2>${subjectName(subject)}</h2><small>${progress.completed} / 30 组完成</small></div><div class="claim-progress" role="progressbar" aria-label="${subjectName(subject)}任务进度" aria-valuenow="${progress.completed}" aria-valuemin="0" aria-valuemax="30"><span style="width:${progress.completed/30*100}%"></span></div>${next?`<div class="claim-status">${progress.activeTask?'已领取 · 进度已保存':'下一组可领取'} · 第${next.day}组</div><h3>${esc(next.title)}</h3><p>${kindName(next.kind)} · 建议${next.minutes}分钟</p><button class="button ${isActive?'secondary':''}" data-action="${progress.activeTask?'select-task':'claim-task'}" data-task="${esc(next.id)}">${progress.activeTask?'继续这组任务':'领取'+subjectName(subject)+'任务'} →</button>`:'<h3>本轮任务已完成</h3><p>可在学习记录回看与重做。</p><a class="button secondary" href="#records">查看学习记录 →</a>'}</article>`;
  }).join('')}</section>`;
}
function renderAside(currentTask) {
  const block = listeningBlock(currentTask);
  return `<aside class="right-column"><section class="paper side-panel"><div class="side-title"><h3>这组怎么安排</h3></div><div class="budget"><strong>${currentTask.minutes}</strong><span>分钟 · 本组建议用时</span></div><p class="offline-note">可以分次完成，刷新后继续。建议时间用于安排练习；达到完成要求即可结束，再决定是否领取下一组。</p></section><section class="hint-panel"><h3>老师的一句提醒</h3><p>${esc(currentTask.type==='listening' ? currentTask.focus || '先预测，原速听一次，再针对错题看文本查漏。合上文本重新听到证据，比记住答案更重要。' : '先读题目要求，找到原文依据。把答案所在的句子读懂，再检查题型规则。')}</p>${block?`<p class="offline-note">${esc(block.goal)}</p>`:''}<a class="text-button" href="#methods">看看具体怎么练 →</a></section>${dueReviews(state).length?`<section class="paper side-panel"><h3>${dueReviews(state).length}道错题到期</h3><p class="offline-note">有空先回忆依据，再核对文本。它们不会阻止你领取新任务。</p><a class="text-button" href="#reviews">打开错题复习 →</a></section>`:''}<section class="paper side-panel"><h3>两科独立，不赶日历</h3><p class="offline-note">无需等另一科完成。这组保存后返回任务大厅，自行领取下一组；复盘也算一组正式任务。</p><a class="text-button" href="#roadmap">查看训练路线 ↗</a></section></aside>`;
}
function listeningBlock(task) {
  return task.type === 'listening' && task.blockId ? LISTENING_BLOCKS.find(block=>block.id===task.blockId) : null;
}
function renderListeningRoute() {
  return `<section class="paper listening-route"><div class="side-title"><h2>听力，按题型一块一块练</h2><a class="text-button" href="#methods">训练方法 ↗</a></div><p class="lead">先完整练10题Part 1，再连续练单选、地图、匹配和多选，逐步进入讨论与讲座。每组做题后只解决1–2个关键问题。</p><ol class="listening-blocks">${LISTENING_BLOCKS.map(block=>`<li><small>第${block.from}–${block.to}组</small><strong>${esc(block.title)}</strong><p>${esc(block.goal)}</p></li>`).join('')}</ol><p class="offline-note">专项建议25–35分钟，阶段轻复盘约15分钟，完整卷约45分钟，整套后的复盘20–25分钟。时间包含核对，是安排参考；达到完成要求可以提前结束。专项与熟题成绩不换算雅思分数。</p></section>`;
}
function renderListeningReferences() {
  return `<details class="paper listening-references"><summary>这套听力练法参考了什么？</summary><p>预读预测、按意思识别改写、检查拼写与字数、利用听力文本查漏，参考以下官方备考资料。训练时长、题型顺序、短精听数量及70%补强线，是按3.5基础制定的本站教学安排。</p><ul>${LISTENING_REFERENCES.map(source=>`<li><a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.title)} ↗</a><p>${esc(source.support)}</p></li>`).join('')}</ul><p class="offline-note">教材题型复核：2026年10月21日。看文本用于复盘；首次做题仍按原速一次独立完成。</p></details>`;
}
function renderListeningPlan(task) {
  const plan = task.type==='listening' ? task.listeningPlan : null;
  if (!plan || (task.questions && plan.newQuestions>0 && task.questions.length!==plan.newQuestions)) return '';
  if (plan.firstPassMinutes + plan.reviewMinutes + plan.spellingMinutes + plan.recallMinutes !== task.minutes) return '';
  const block = listeningBlock(task), adapt = getAdaptation(state,task);
  const allocations = [['预读、做题与核对',plan.firstPassMinutes],['解决关键问题',plan.reviewMinutes],['针对错词检查',plan.spellingMinutes],['遗留问题回顾',plan.recallMinutes]];
  if (adapt?.minutes > 0) {
    let remaining = adapt.minutes;
    for (const i of [1,3,2]) { const taken = Math.min(remaining,allocations[i][1]); allocations[i][1] -= taken; remaining -= taken; }
    allocations.unshift(['先补基础',adapt.minutes-remaining]);
  }
  const segments = plan.segments;
  return `<section class="listening-plan">${block?`<div class="block-caption">第${block.from}–${block.to}组 · ${esc(block.title)}</div>`:''}<div class="side-title"><h3>${plan.newQuestions ? `本次题组 ${plan.newQuestions} 道` : '只回顾尚未解决的问题'}</h3><small>建议 ${task.minutes} 分钟</small></div>${task.focus?`<p class="daily-focus"><b>本组重点：</b>${esc(task.focus)}</p>`:''}<p>${esc(plan.instruction)}</p>${task.exposureNote?`<p class="plan-limit"><b>材料说明：</b>${esc(task.exposureNote)}</p>`:''}${task.adaptiveSelection?`<p class="daily-focus"><b>选材依据：</b>${esc(task.adaptiveSelection.reason)}</p>`:''}<div class="practice-budget">${allocations.filter(([,minutes])=>minutes>0).map(([label,minutes])=>`<div><strong>${minutes}<small> min</small></strong><span>${label}</span></div>`).join('')}</div>${adapt?.minutes>0?`<p class="plan-limit">补强从本组时间中调配，总时长仍为${task.minutes}分钟。</p>`:''}<p class="plan-limit">${segments ? `只选尚未听清的1–${segments}处，每处不超过${plan.segmentSeconds}秒；盲听最多3次，再看文本理解，合上文本原速回听。${plan.dictationSentences>0?`听写最多${plan.dictationSentences}句。`:'听写选做，拼写错才检查对应词。'}没有卡点就结束，不必逐题重听或凑满时间。` : '本组完成整套与核对记录即可，精听留给下一组；不要求一次复盘40题。'}</p>${task.successCheck?`<p class="success-check"><b>做到这些就结束：</b>${esc(task.successCheck)}</p>`:''}${block?`<details class="block-check"><summary>这一题型练到什么程度？</summary><p>${esc(block.readyWhen)}</p></details>`:''}</section>`;
}
function legacyListeningNotice(task) {
  return task.type==='listening' && task.curriculumVersion!=='listening-v3' ? '<p class="banner">这是已开始的旧任务，原教材与学习记录已保留。按当前精简方法完成即可，无需凑原定时长；下一组未开始的任务使用新安排。</p>' : '';
}
function adaptationHtml(task) {
  if (task.adaptiveSelection) return '';
  const adapt = getAdaptation(state,task);
  if (!adapt) return '';
  return `<div class="banner warn"><b>${adapt.minutes>0?'为你调整了训练':'老师的补强建议'}</b><br>${esc(adapt.reason)}<br>${adapt.minutes>0?`用${adapt.minutes}分钟${esc(adapt.action)}，替换本组部分训练。`:esc(adapt.action)}</div>`;
}
function renderTaskIntro(task,method) {
  const count = questionsFor(task).length, adapt = getAdaptation(state,task);
  const full = ['mock','diagnostic'].includes(task.kind);
  return `<div class="lesson-body"><div class="subject-label">${task.type==='reading'?'READING':'LISTENING'} <span>·</span> ${kindName(task.kind)}</div><h2>${esc(task.title)}</h2><p class="lead">在你习惯的做题网站或教材上完成，核对答案后回来标记对错。本站记录学习结果，不需要再抄一遍答案。</p><div class="resource-list">${resourcesHtml(task)}</div>${renderListeningPlan(task)}${legacyListeningNotice(task)}${task.replacement ? `<div class="banner">原计划试卷已见，已换成 ${esc(task.replacement)}。</div>`:''}${task.fresh === false && full ? '<div class="banner warn">这套卷子已练过或看过内容，本次作为复测。</div>':''}${adaptationHtml(task)}<div class="section-caption">怎么练这一组</div>${guideHtml(method,true)}<details class="details-block"><summary>看完整方法与示范</summary>${guideHtml(method)}${exampleHtml(method)}</details>${full?`<div class="banner" style="margin-top:20px">${task.type==='reading'?'完整阅读在做题网站按60分钟独立完成。':'完整听力原速播放一次，末尾按机考规则留2分钟核对。'}首次成绩记录订正前的结果，重听、看解析后做对的题另算复习。</div>`:''}</div><footer class="lesson-footer"><small>${count} 道题 · 做完后只标对错</small><button class="button" data-action="start" data-task="${task.id}">我已做完，记录对错 <span>→</span></button></footer>`;
}
function exampleHtml(method) {
  if (!method?.example) return '';
  return `<div class="method-example"><b>原创方法示范 · 非剑桥真题</b><p class="english" lang="en">${esc(method.example.prompt)}</p><p>${esc(method.example.explanation)}</p></div>`;
}
function renderAttempt(task,attempt) {
  if (attempt.completedAt) return renderResult(task,attempt);
  const marked = attempt.questions.filter(q=>typeof q.correct==='boolean').length;
  const wrong = attempt.questions.filter(q=>q.correct===false).length;
  const full = ['diagnostic','mock'].includes(attempt.kind);
  return `<div class="lesson-body"><div class="subject-label">${subjectName(attempt.subject)} · 逐题记录${attempt.redo?' · 重做':''}</div><h2>${esc(attempt.title || task.title)}</h2>${legacyListeningNotice(task)}<div class="resource-list">${resourcesHtml(task)}</div><p class="lead">对照你做题网站或教材的批改结果，标记第一次作答的对错。漏答、拼写或字数不符也记为错误。</p><div class="marking-toolbar"><span><b>${marked} / ${attempt.questions.length}</b> 已标记 · ${wrong} 道错误</span><button class="button secondary small" data-action="grade-rest" ${marked===attempt.questions.length?'disabled':''}>其余未标记题全部正确</button></div><div class="selfcheck-grid">${attempt.questions.map((q,i)=>renderGrade(q,i)).join('')}</div><div class="subheading">补充记录 <small class="muted">选填</small></div><label class="external-duration">本次做题用时（分钟）<input type="number" min="0" max="1440" step="0.5" data-duration="${attempt.id}" value="${attempt.durationProvided?Math.round(attempt.elapsedSeconds/60*10)/10:''}" placeholder="不填也可以保存成绩"></label><details class="details-block"><summary>记录一个收获或主要问题（选填）</summary><label style="margin-top:12px">本组笔记<textarea data-attempt-note="${attempt.id}" placeholder="例如：改口后的信息才是答案；下次检查单复数。">${esc(attempt.note || '')}</textarea></label></details>${full?`<div class="form-meta"><input id="normalConditions" type="checkbox" ${attempt.normalConditions===true?'checked':''}><label for="normalConditions">本次是未见过的完整卷，已按考试条件独立完成（${attempt.subject==='reading'?'阅读60分钟':'听力原速一次，末尾2分钟核对'}），记录的是订正前成绩。未勾选则保存为普通练习。</label></div>`:''}</div><footer class="lesson-footer"><small>对错自动保存，错因和笔记选填</small><button class="button" data-action="finish-attempt">保存本组成绩 <span>→</span></button></footer>`;
}
const CAUSES = {
  reading:['词汇不认识','句子没读懂','定位错误','同义替换没识别','题型规则混淆','字数或拼写错误','时间不足','待分析'],
  listening:['没有听出词音','跟丢定位','同义替换没识别','干扰项或改口','拼写或单复数','读题来不及','时间不足','待分析'],
};
function renderGrade(q,i) {
  const subject = currentFocusedAttempt()?.subject || 'reading';
  return `<div class="grade-item ${q.correct===false?'is-wrong':q.correct===true?'is-correct':''}"><div class="grade-head"><div class="grade-answer"><small>${esc(q.label)}</small></div><div class="grade-choices"><button class="grade-choice good ${q.correct===true?'selected':''}" data-action="grade" data-index="${i}" data-correct="true" aria-pressed="${q.correct===true}" aria-label="${esc(q.label)} 正确">✓ 对</button><button class="grade-choice bad ${q.correct===false?'selected':''}" data-action="grade" data-index="${i}" data-correct="false" aria-pressed="${q.correct===false}" aria-label="${esc(q.label)} 错误">× 错</button></div></div>${q.correct===false?`<details class="wrong-detail"><summary>错因 / 复盘（选填）</summary><div class="grade-detail"><label>失分原因<select data-cause="${i}"><option value="">暂不填写</option>${CAUSES[subject].map(c=>`<option ${q.cause===c?'selected':''}>${esc(c)}</option>`).join('')}</select></label><label>记一句提醒或依据<textarea data-evidence="${i}" placeholder="也可以直接回做题网站看解析，无需在这里抄答案。">${esc(q.evidence || '')}</textarea></label></div></details>`:''}</div>`;
}
function attemptDuration(a) { return a.recordingMode==='self-check' && !a.durationProvided ? '用时未记录' : `用时 ${fmtTime(a.elapsedSeconds)}`; }
function renderResult(task,a) {
  const correct = a.score?.correct ?? a.correctCount ?? a.questions.filter(q=>q.correct).length;
  const total = a.questions.length, wrong = total-correct;
  return `<div class="lesson-body"><div class="subject-label">${subjectName(a.subject)} · 本组已完成</div><h2>做完，也弄懂一点。</h2><div class="result-score">${correct}<small> / ${total}</small></div><p class="lead">${a.redo?'重做成绩':isFreshFullAttempt(a)?'全新完整卷 · 首次成绩':'专项 / 已见内容练习'} · ${attemptDuration(a)}</p><div class="result-note">${wrong?`${wrong}道错题已加入复习，安排在次日、3天后和7天后回忆。`:'这组全部正确。下次继续用原文或音频证据验证自己的判断。'}${total<40?'<br>专项成绩用于观察题型进步，不换算雅思分数。':''}${total===40?'<br>训练争取稳定30/40。正式分数依试卷换算，不作提分保证。':''}</div>${a.reviewScheduleNote?`<p class="lead">${esc(a.reviewScheduleNote)}</p>`:''}${a.subject==='listening' && a.kind==='practice' && task.curriculumVersion==='listening-v3'?'<div class="banner"><b>本组收尾</b><br>只处理尚未解决的1–2个问题：听辨错，回听短片段；干扰错，对比选项证据；拼写错，检查对应词。已听清就结束，听写选做。</div>':''}${a.note?`<div class="section-caption">这次记住的事</div><p class="lead">${esc(a.note)}</p>`:''}<details class="details-block"><summary>回看本组对错与复盘</summary>${a.questions.map(q=>`<div class="review-answer"><b>${esc(q.label)} · ${q.correct?'✓':'×'}</b>${q.answer?`<br><span lang="en">原作答：${esc(q.answer)}</span>`:''}${!q.correct?`<br>${esc(q.cause || '待分析')}<br>${esc(q.evidence || '回到对应题目的解析或音频复习即可。')}`:''}</div>`).join('')}</details></div><footer class="lesson-footer"><a class="text-button" href="#records">查看学习记录 ↗</a><div class="button-row" style="margin:0"><button class="button secondary small" data-action="redo-attempt" data-id="${esc(a.id)}">重做这一组</button><button class="button" data-action="next">返回大厅，领取下一组 →</button></div></footer>`;
}
function renderGeneral(task) {
  const note = state.taskNotes?.[task.id] || {};
  const source = state.attempts.find(a=>a.id===task.analysisOf&&a.completedAt) || (task.sourceDay ? state.attempts.find(a=>a.day===task.sourceDay&&a.subject===task.type&&a.completedAt&&!a.redo) : null);
  let content = '';
  if (task.kind==='analysis') {
    const wrong = source?.questions.filter(q=>q.correct===false) || [];
    const checklist = task.reviewChecklist || (task.type==='reading' ? ['找到错题对应的原文依据，分清定位、理解和规则问题。','精读2–3个关键段落，拆解影响答案的长句。','整理至少3组题干与原文的同义替换，合上书再解释一次。'] : ['先找出尚未解决的主要问题；前次已听清的片段直接跳过。','听辨问题只选1–2处短片段查文本；干扰问题核对选项证据，拼写问题检查对应词，听写选做。','合上文本确认已听清即可结束；没有遗留问题时，快速回看就能完成本组。']);
    content = `${source?`<div class="result-note">复盘第${task.sourceDay}组的${subjectName(task.type)}：${source.score?.correct ?? source.correctCount ?? 0} / ${source.questions.length}。${wrong.length?'先从失分最多的地方开始。':'本组没有错题，只需确认是否还有不确定的地方。'}</div>`:'<div class="banner warn">还没有找到对应的练习成绩。请使用对应任务实际做过的试卷，按下面步骤复盘并留下记录。</div>'}${task.type==='listening' ? `<p class="lead">已解决的片段不用再听。没有遗留问题，快速回看后就可以完成本组。</p><ol class="step-guide">${checklist.map(s=>`<li><span>${esc(s)}</span></li>`).join('')}</ol>` : `<div class="checklist">${checklist.map((s,i)=>`<label><input type="checkbox" data-check="${i}" ${note.checks?.[i]?'checked':''}><span>${esc(s)}</span></label>`).join('')}</div>`}${wrong.length?`<details class="details-block"><summary>回看 ${wrong.length} 道错题</summary>${wrong.map(q=>`<div class="review-answer"><b>${esc(q.label)} · ${esc(q.cause || '待分析')}</b><br>${esc(q.evidence || '暂未记录依据，请回到原文或音频寻找。')}</div>`).join('')}</details>`:''}<div class="subheading">复盘笔记（选填）</div><label>具体依据、同义替换或听辨发现<textarea data-task-note="${task.id}" placeholder="把发现写成下一次可执行的动作。">${esc(note.text || '')}</textarea></label>`;
  } else if (task.kind==='review') {
    content = `<div class="banner">当前没有足够的${subjectName(task.type)}错题需要重做。只复习已有内容，剩余时间回看同义替换，不凑题量。</div><a class="button secondary" href="#reviews">打开错题本</a><label style="margin-top:20px">这次复习发现<textarea data-task-note="${task.id}">${esc(note.text || '')}</textarea></label>`;
  } else {
    content = `<div class="banner">本组轻量复习，不再靠大量刷题获得安全感。用真实模考成绩判断自己的节奏。</div><div class="checklist">${(task.type==='reading'?['回看常错的题型规则、字数和拼写。','确定做题顺序；阅读60分钟包含填答，没有额外转写时间。','回忆最常见的同义替换，检查机考键入习惯。']:['回看数字、日期、单复数及常错拼写。','记住原速播放一次，跟丢一题就准备下一题。','确认机考末尾核对规则；复习常见改口和干扰信号。']).map((s,i)=>`<label><input type="checkbox" data-check="${i}" ${note.checks?.[i]?'checked':''}><span>${s}</span></label>`).join('')}</div><label>带进考场的一句提醒（选填）<textarea data-task-note="${task.id}">${esc(note.text || '')}</textarea></label>`;
  }
  const adapt = getAdaptation(state,task);
  return `<div class="lesson-body"><div class="subject-label">${subjectName(task.type)} · ${kindName(task.kind)}</div><h2>${esc(task.title)}</h2><div class="resource-list">${resourcesHtml(task)}</div>${adaptationHtml(task)}${renderListeningPlan(task)}${legacyListeningNotice(task)}<div style="margin-top:20px">${content}</div></div><footer class="lesson-footer"><small>完成本组后，可自行领取下一组。</small><button class="button" data-action="complete-general" data-task="${task.id}">完成这组任务 →</button></footer>`;
}
function renderRoadmap() {
  const subject = runtime.routeSubject, progress = subjectProgress(state,subject);
  const next = progress.activeTask || progress.nextTask;
  return `${head('一条循序渐进的训练路线。','每科30组，自行安排领取节奏。两科进度互不锁定。','YOUR LEARNING ROUTE')}<div class="method-tabs">${['listening','reading'].map(id=>`<button class="filter-button ${subject===id?'active':''}" data-action="route-filter" data-filter="${id}">${subjectName(id)}路线</button>`).join('')}</div>${subject==='listening'?renderListeningRoute():'<div class="banner">阅读从填空入门，再练判断、匹配与选择，最后用完整新卷检验。每组按顺序领取，难题有独立复盘任务。</div>'}<div class="roadmap-grid">${DAYS.map(d=>{
    const t=tasksForDay(state,d.day).find(t=>t.type===subject), done=!!state.completed[t.id], claimed=!!state.claimedTasks?.[t.id];
    return `<button class="day-card ${t.id===next?.id?'current-day':''}" data-action="preview-task" data-day="${d.day}" data-subject="${subject}"><div class="day-card-head"><strong>${String(d.day).padStart(2,'0')}</strong><span class="pill ${done?'green':claimed?'':'neutral'}">${done?'已完成':claimed?'已领取':t.id===next?.id?'可领取':'路线预览'}</span></div><h3>${esc(t.title)}</h3><p>${kindName(t.kind)} · 建议${t.minutes}分钟</p>${t.focus?`<p>${esc(t.focus)}</p>`:''}</button>`;
  }).join('')}</div>`;
}
function renderMethods() {
  const methods = Object.values(METHODS).filter(m=>runtime.methodFilter==='all'||m.subject===runtime.methodFilter);
  return `${head('知道怎么练，才不白做题。','先掌握方法，再用真题验证。以下小示范均为原创，非剑桥题文。','PRACTICE WITH A METHOD',false)}<div class="method-tabs">${[['all','全部方法'],['reading','阅读'],['listening','听力']].map(([id,label])=>`<button class="filter-button ${runtime.methodFilter===id?'active':''}" data-action="method-filter" data-filter="${id}">${label}</button>`).join('')}</div>${runtime.methodFilter!=='reading'?renderListeningReferences():''}<div class="method-grid">${methods.map(m=>`<article class="paper method-card"><span class="pill">${subjectName(m.subject)}</span><h3 style="margin-top:12px">${esc(m.title)}</h3><p>${esc(m.intro)}</p><details><summary>展开训练步骤与原创示范</summary><div style="margin-top:17px">${guideHtml(m)}${exampleHtml(m)}${m.pitfalls?.length?`<ul class="pitfalls">${m.pitfalls.map(t=>`<li>${esc(t)}</li>`).join('')}</ul>`:''}</div></details></article>`).join('')}</div>`;
}
function renderReviews() {
  const due = dueReviews(state);
  const all = state.reviews || [];
  const list = runtime.reviewFilter==='all' ? all : due;
  return `${head('把错过的，再做明白。','先遮住依据，回忆为什么选；再翻回教材验证。','RECALL · VERIFY · REMEMBER',false)}<div class="method-tabs"><button class="filter-button ${runtime.reviewFilter==='due'?'active':''}" data-action="review-filter" data-filter="due">到期复习 ${due.length}</button><button class="filter-button ${runtime.reviewFilter==='all'?'active':''}" data-action="review-filter" data-filter="all">全部错题 ${all.length}</button></div>${list.length?list.map(r=>`<article class="paper review-card"><div class="review-card-head"><div><span class="pill ${r.subject==='reading'?'':'neutral'}">${subjectName(r.subject)}</span><strong style="margin-left:9px">${esc(r.label)}</strong></div><span class="pill ${r.completed?'green':'neutral'}">${r.completed?'已完成三轮':`第${(r.stage||0)+1}轮 · ${esc(r.dueDate)}`}</span></div><p>失分原因：${esc(r.cause || '待分析')} · 累计出错 ${r.failures || 1} 次</p><details><summary>我已回忆，查看复习提醒</summary><div class="review-answer">${r.answer?`<b>当时作答：</b><span lang="en">${esc(r.answer)}</span><br>`:''}<b>复习提醒 / 依据：</b>${esc(r.evidence || '回到做题网站或教材，查看这道题的依据。')}</div></details><label style="margin-top:12px">补充一句复习提醒（选填）<input data-review-evidence="${esc(r.id)}" value="${esc(r.evidence || '')}" placeholder="例如：这题因改口听错，下次等完整句"></label>${!r.completed?`<div class="button-row"><button class="button small" data-action="review-pass" data-id="${esc(r.id)}" ${r.dueDate>dateKey()?'disabled title="未到复习日，可先回看依据"':''}>${r.dueDate>dateKey()?'未到复习日，先回看':'回忆正确，安排下一轮'}</button><button class="button secondary small" data-action="review-fail" data-id="${esc(r.id)}">仍不熟，明天再来</button></div>`:''}</article>`).join(''):`<div class="paper empty-state"><span>↺</span><h2>${all.length?'今天的到期错题已复习完':'错题本，从一次认真批改开始'}</h2><p>${all.length?'按1、3、7天的间隔回忆。现在可以返回任务大厅。':'完成一组真题并标出对错，错题就会按题号出现在这里。'}</p><a class="button" href="#today">返回任务大厅 →</a></div>`}`;
}
function renderRecords() {
  const attempts = state.attempts.filter(a=>a.completedAt).slice().reverse();
  const full = attempts.filter(a=>isFreshFullAttempt(a)).slice().reverse();
  const done = ['reading','listening'].reduce((n,subject)=>n+subjectProgress(state,subject).completed,0);
  const latest = subject=>attempts.find(a=>a.subject===subject&&isFreshFullAttempt(a));
  const rawScore = a=>a ? `${a.score?.correct ?? a.correctCount ?? 0}/40` : '—';
  return `${head('用真实记录，看见进步。','首次与重做分开，专项与完整卷分开。没有练习数据时不生成示例成绩。','YOUR LEARNING RECORD',false)}<div class="metrics"><div class="metric"><small>阅读 · 最近全新完整卷</small><strong>${rawScore(latest('reading'))}</strong><span>训练目标稳定30/40</span></div><div class="metric"><small>听力 · 最近全新完整卷</small><strong>${rawScore(latest('listening'))}</strong><span>训练目标稳定30/40</span></div><div class="metric"><small>已完成训练</small><strong>${done}<span style="font-size:15px;color:#97a4b8"> / 60</span></strong><span>阅读、听力任务独立累计</span></div><div class="metric"><small>领取后待完成</small><strong>${getClaimedTasks(state).length}</strong><span>可随时接续已领取的任务</span></div></div>${full.length?`<section class="paper chart-panel"><div class="side-title"><h3>全新完整卷 · 首次正确题数</h3><small>满分40 · 深蓝阅读 / 浅蓝听力</small></div><div class="score-chart">${full.map(a=>{const correct=a.score?.correct??a.correctCount??0;return `<div class="score-column ${a.subject}"><strong>${correct}</strong><div class="bar" style="height:${correct/40*125}px"></div><small>第${a.day}组 · ${subjectName(a.subject)}</small></div>`;}).join('')}</div></section>`:''}<div class="button-row" style="margin:0 0 20px"><button class="button secondary small" data-action="export">导出学习备份</button><button class="button secondary small" data-action="import">导入备份</button><button class="text-button" data-action="settings">已做试卷设置</button></div>${attempts.length?`<section class="paper records-table-wrap"><table class="records-table"><thead><tr><th>训练</th><th>科目</th><th>成绩</th><th>记录类型</th><th>用时</th><th>查看</th></tr></thead><tbody>${attempts.map(a=>`<tr><td>第${a.day}组 · ${esc(a.title || kindName(a.kind))}</td><td>${subjectName(a.subject)}</td><td><strong>${a.score?.correct??a.correctCount??0} / ${a.questions.length}</strong></td><td><span class="pill ${isFreshFullAttempt(a)?'green':'neutral'}">${a.redo?'重做':a.questions.length===40?(isFreshFullAttempt(a)?'全新完整卷':'完整卷练习'):'专项练习'}</span></td><td>${a.recordingMode==='self-check'&&!a.durationProvided?'未记录':fmtTime(a.elapsedSeconds)}</td><td><button class="text-button" data-action="view-attempt" data-id="${esc(a.id)}">回看 ↗</button></td></tr>`).join('')}</tbody></table></section>`:`<div class="paper empty-state"><span>▥</span><h2>第一份成绩，来自第一组练习</h2><p>在做题网站完成并核对后，网站会记录结果。专项成绩只反映这组练习，不直接估算雅思分数。</p><a class="button" href="#today">领取第一组任务 →</a></div>`}<div class="banner" style="margin-top:22px">3.5是起点自评，6.5是冲刺目标。正式分数取决于实际考试；请结合完整新卷表现判断准备程度。</div>`;
}

function currentFocusedAttempt() {
  const focus = state.attempts.find(a=>a.id===runtime.focusAttempt);
  if (focus) return focus;
  const task = getSelectedTask(state);
  return task ? activeAttempt(task) || (state.completed[task.id] ? completedAttempt(task.id) : null) : null;
}
function currentResolvedTask() {
  const a = currentFocusedAttempt();
  if (a) return tasksForDay(state,a.day).find(t=>t.id===a.taskId);
  return getSelectedTask(state);
}
function openModal(html) { $('#modalContent').innerHTML = html; if (!$('#modal').open) $('#modal').showModal(); }
function closeModal() { $('#modal').close(); }
function authModal() {
  if (runtime.user) {
    openModal(`<h2>学习账号</h2><p>${esc(runtime.user.email)}</p><div class="banner">学习记录先保存在本机，再同步到你的账号。换设备时使用同一邮箱登录。</div><div class="button-row"><button class="button" data-action="pull">读取云端最新记录</button><button class="button secondary" data-action="export">导出备份</button></div><div class="divider"></div><button class="text-button" data-action="logout">退出当前账号</button>`);return;
  }
  openModal(`<h2>让每台设备，都接着练。</h2><p>登录后，手机和电脑可以接续同一份学习记录。</p><div class="auth-tabs"><button class="auth-tab ${runtime.authMode==='login'?'active':''}" data-action="auth-tab" data-tab="login">登录已有账号</button><button class="auth-tab ${runtime.authMode==='signup'?'active':''}" data-action="auth-tab" data-tab="signup">注册新账号</button></div><form id="authForm" class="form-stack"><label>邮箱<input name="email" type="email" autocomplete="email" placeholder="you@example.com" required></label><label>密码<input name="password" type="password" autocomplete="${runtime.authMode==='signup'?'new-password':'current-password'}" minlength="8" placeholder="至少8位" required></label><p class="form-message" id="authMessage" role="status"></p><button class="button full" type="submit">${runtime.authMode==='signup'?'注册并开始训练':'登录并同步'}</button></form><div class="divider"></div><p class="offline-note">未登录也能先在当前浏览器练习。新账号不会自动混入访客或其他账号的记录；如需迁移，先导出，再登录导入。</p>${!cloud.configured?'<div class="banner warn" style="margin-top:15px">云端尚未配置，当前可使用本机训练与备份。</div>':''}`);
}
function settingsModal() {
  openModal(`<h2>让计划贴合你的起点</h2><p>已经做过、看过原文、答案或听力文本的试卷，请按科目勾选。网站会为诊断和模考优先换新卷。</p><div class="divider"></div>${['reading','listening'].map(subject=>`<h3 style="margin-top:18px">${subjectName(subject)} · 已见试卷</h3><div class="exposure-grid">${[15,16,17,18,19,20].map(book=>`<div class="exposure-book"><strong>剑${book}</strong>${[1,2,3,4].map(test=>`<label><input type="checkbox" data-exposure="${subject}" data-book="${book}" data-test="${test}" ${state.exposures[`${subject}-${book}-${test}`]?.seen?'checked':''}>Test ${test}</label>`).join('')}</div>`).join('')}</div>`).join('')}<div class="banner" style="margin-top:20px">新卷替补顺序：剑19 T3、T4 → 剑20 T1–T4。已练内容会持续标为已见；两科分别判断。</div><div class="button-row"><button class="button" data-action="save-settings">保存设置</button><button class="button secondary" data-action="close-modal">返回训练</button></div>`);
}
function previewDay(day, subject = runtime.routeSubject) {
  const planned=tasksForDay(state,day).find(t=>t.type===subject); if(!planned)return;
  const task=state.claimedTasks?.[planned.id] ? resolveTask(state,planned) : planned;
  const progress=subjectProgress(state,subject), available=(progress.activeTask || progress.nextTask)?.id===task.id;
  const done=!!state.completed[task.id];
  openModal(`<div class="overline">${subjectName(subject)} · 第${day} / 30组</div><h2>${esc(task.title)}</h2><p>${done?'已完成':state.claimedTasks?.[task.id]?'已领取':available?'可以领取':'后续任务预览'} · 建议${task.minutes}分钟</p><div class="resource-list">${resourcesHtml(task)}</div>${renderListeningPlan(task)}${!task.resources.length?`<p class="lead">${task.kind==='analysis'?`复盘第${task.sourceDay}组实际做过的试卷。`:'回看错题与已经记录的方法。'}</p>`:''}<details class="details-block"><summary>查看训练步骤</summary>${guideHtml(METHODS[task.methodId])}</details><div class="button-row">${available?`<button class="button" data-action="claim-task" data-task="${task.id}">${progress.activeTask?'继续这组任务':'领取这组任务'} →</button>`:''}<button class="button secondary" data-action="close-modal">返回路线</button></div>${!available&&!done?'<p class="offline-note">完成这一科已领取的任务后，再领取下一组；另一科可以独立领取。</p>':''}`);
}
function exportBackup() {
  const data = {app:'ielts-coach',version:1,exportedAt:new Date().toISOString(),state};
  const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=`听读有方-${dateKey()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('学习备份已导出。');
}
async function importBackup(file) {
  if (!file) return;
  try {
    const data=JSON.parse(await file.text());
    if (data.app!=='ielts-coach'||data.version!==1||!data.state||!Array.isArray(data.state.attempts)) throw new Error('这不是听读有方的有效备份。');
    const imported=normalizeState(data.state);
    runtime.pendingImport=imported;
    openModal(`<h2>导入这份学习记录？</h2><p>当前记录会被替换。建议先导出当前备份，方便恢复。</p><div class="banner">当前：${countSummary(state)}<br>备份：${countSummary(imported)}</div><div class="button-row"><button class="button" data-action="confirm-import">确认导入</button><button class="button secondary" data-action="export">先备份当前记录</button></div>`);
  } catch(e){toast(e.message || '无法读取备份文件。');}
  $('#importFile').value='';
}

document.addEventListener('click', async e=>{
  const el=e.target.closest('[data-action]');if(!el)return;
  const action=el.dataset.action;
  try {
    if(action==='claim-task') {
      claimTask(state,el.dataset.task);runtime.focusAttempt=null;persist();closeModal();location.hash='today';render();window.scrollTo({top:0,behavior:'smooth'});
    } else if(action==='select-task') {
      clearTimeout(runtime.saveTimer);
      selectTask(state,el.dataset.task);runtime.focusAttempt=null;persist();render();window.scrollTo({top:0,behavior:'smooth'});
    } else if(action==='start') {
      const t=getSelectedTask(state);if(!t||t.id!==el.dataset.task||state.completed[t.id])return;
      const a=startAttempt(state,resolveTask(state,t));runtime.focusAttempt=a.id;persist();render();
    } else if(action==='grade'){
      const a=currentFocusedAttempt();if(!a?.submittedAt||a.completedAt)return;
      a.questions[Number(el.dataset.index)].correct=el.dataset.correct==='true';persist();render();
    } else if(action==='grade-rest'){
      const a=currentFocusedAttempt();if(!a||a.completedAt)return;
      a.questions.forEach(q=>{if(typeof q.correct!=='boolean')q.correct=true;});persist();render();
    } else if(action==='finish-attempt'){
      const a=currentFocusedAttempt();if(!a)return;
      if(a.questions.some(q=>typeof q.correct!=='boolean')){toast('请先对照教材，逐题标记正确或错误。');return;}
      if(['diagnostic','mock'].includes(a.kind)&&a.normalConditions!==true){a.normalConditions=false;a.fresh=false;a.conditionNote='未确认按考试条件完成，不纳入全新完整卷成绩。';}
      finishAttempt(state,a.id);runtime.focusAttempt=a.id;persist();render();window.scrollTo({top:0,behavior:'smooth'});
    } else if(action==='next'){runtime.focusAttempt=null;state.selectedTaskId=null;persist();render();window.scrollTo({top:0,behavior:'smooth'});}
    else if(action==='complete-general'){
      const t=getSelectedTask(state);if(!t||t.id!==el.dataset.task)return;
      if(['analysis','wrapup'].includes(t.kind) && t.type!=='listening'){
        const n=state.taskNotes[t.id];if(!n?.checks?.every(Boolean)||n.checks.length<3){toast('完成三项回顾后即可保存，笔记可以不填。');return;}
      }
      completeTask(state,t.id);state.selectedTaskId=null;persist();render();window.scrollTo({top:0,behavior:'smooth'});toast('本组已完成，下一组由你领取。');
    } else if(action==='method-filter'){runtime.methodFilter=el.dataset.filter;render();}
    else if(action==='review-filter'){runtime.reviewFilter=el.dataset.filter;render();}
    else if(action==='review-pass'||action==='review-fail'){
      recordReview(state,el.dataset.id,action==='review-pass');persist();render();toast(action==='review-pass'?'已安排下一轮复习。':'明天再回忆这道题。');
    } else if(action==='route-filter'){runtime.routeSubject=el.dataset.filter;render();}
    else if(action==='preview-task')previewDay(Number(el.dataset.day),el.dataset.subject);
    else if(action==='return-today'){closeModal();location.hash='today';runtime.focusAttempt=null;render();}
    else if(action==='account')authModal();
    else if(action==='cloud-help')openModal(`<h2>一次性开启跨设备同步</h2><p>账号功能已接入，需要在你现有的云服务里创建本站独立学习表。本机练习与备份现在就能使用。</p><ol class="step-guide"><li><span>下载下面的建表脚本，打开对应 Supabase 项目的 SQL Editor。</span></li><li><span>粘贴脚本并运行一次，它只创建本站学习表和版本检查函数。</span></li><li><span>回到网站，使用同一邮箱在手机、电脑登录，再点击“读取云端最新记录”。</span></li></ol><div class="button-row"><a class="button" href="./supabase-setup.sql" download>下载建表脚本</a><a class="button secondary" href="./README.md" target="_blank">打开部署说明</a></div>`);
    else if(action==='auth-tab'){runtime.authMode=el.dataset.tab;authModal();}
    else if(action==='close-modal')closeModal();
    else if(action==='settings')settingsModal();
    else if(action==='save-settings'){
      document.querySelectorAll('[data-exposure]').forEach(input=>setExposure(state,input.dataset.exposure,Number(input.dataset.book),Number(input.dataset.test),input.checked));
      persist();closeModal();runtime.focusAttempt=null;render();toast('已保存，诊断和模考会优先使用未见卷。');
    } else if(action==='export')exportBackup();
    else if(action==='import')$('#importFile').click();
    else if(action==='confirm-import'){
      state=runtime.pendingImport;runtime.pendingImport=null;runtime.focusAttempt=null;persist();closeModal();render();toast('学习记录已导入。');
    } else if(action==='logout'){await cloud.signOut();closeModal();render();}
    else if(action==='pull'){await cloud.pull();closeModal();toast('已检查云端记录。');}
    else if(action==='conflict-local'||action==='conflict-remote'){
      const choice=action==='conflict-local'?'local':'remote';await cloud.resolveConflict(choice);runtime.conflict=null;closeModal();render();
    } else if(action==='view-attempt'){
      runtime.focusAttempt=el.dataset.id;location.hash='today';render();window.scrollTo({top:0,behavior:'smooth'});
    } else if(action==='redo-attempt'){
      const old=state.attempts.find(a=>a.id===el.dataset.id);if(!old?.completedAt)return;
      const task=tasksForDay(state,old.day).find(t=>t.id===old.taskId);const a=startAttempt(state,task);runtime.focusAttempt=a.id;location.hash='today';persist();render();

    }
  } catch(err){toast(err.message || '操作暂未完成，记录已保留。');console.error(err);}
});

document.addEventListener('input', e=>{
  const el=e.target,a=currentFocusedAttempt(),t=currentResolvedTask();
  if(el.dataset.duration&&a){try{setExternalDuration(state,a.id,el.value.trim()===''?null:Number(el.value)*60);}catch{return;}}
  else if(el.dataset.evidence!==undefined&&a)a.questions[Number(el.dataset.evidence)].evidence=el.value;
  else if(el.dataset.attemptNote&&a)a.note=el.value;
  else if(el.dataset.taskNote){state.taskNotes[el.dataset.taskNote]??={checks:[false,false,false],text:''};state.taskNotes[el.dataset.taskNote].text=el.value;}
  else if(el.dataset.reviewEvidence){const r=state.reviews.find(r=>r.id===el.dataset.reviewEvidence);if(r)r.evidence=el.value;}
  else return;
  saveSoon();
});
document.addEventListener('change',e=>{
  const el=e.target,a=currentFocusedAttempt(),t=currentResolvedTask();
  if(el.dataset.cause!==undefined&&a)a.questions[Number(el.dataset.cause)].cause=el.value;
  else if(el.id==='normalConditions'&&a)a.normalConditions=el.checked;
  else if(el.dataset.check!==undefined&&t){state.taskNotes[t.id]??={checks:[false,false,false],text:''};state.taskNotes[t.id].checks[Number(el.dataset.check)]=el.checked;}
  else return;
  persist();
});
document.addEventListener('submit',async e=>{
  if(e.target.id==='authForm'){
    e.preventDefault();const data=new FormData(e.target),button=$('button[type=submit]',e.target),msg=$('#authMessage');button.disabled=true;msg.textContent='正在连接…';
    try {
      const result=runtime.authMode==='signup'?await cloud.signUp(String(data.get('email')).trim(),String(data.get('password'))):await cloud.signIn(String(data.get('email')).trim(),String(data.get('password')));
      if(result?.confirmationRequired){msg.textContent='已发送确认邮件，请确认邮箱后回来登录。';return;}
      if(!runtime.user){msg.textContent='请确认邮箱或账号信息后重新登录。';return;}
      if(result?.conflict){render();toast('本机与云端都有更新，请先选择继续使用哪份记录。');return;}
      if(result?.state&&!result.conflict){state=normalizeState(result.state);writeLocal();}
      else if(!result?.state)await cloud.save(clone(state));
      closeModal();render();toast('已登录，学习记录按账号保存。');
    }catch(err){if(msg.isConnected)msg.textContent=err.message || '连接失败，请检查网络。';}
    finally{button.disabled=false;}
  }
});
$('#importFile').addEventListener('change',e=>importBackup(e.target.files[0]));
window.addEventListener('hashchange',()=>{render();window.scrollTo({top:0});});
window.addEventListener('pagehide',()=>{clearTimeout(runtime.saveTimer);persist();});
window.addEventListener('online',()=>{if(runtime.user)cloud.pull().catch(()=>{});});
$('#modal').addEventListener('click',e=>{if(e.target===$('#modal'))closeModal();});
render();
cloud.init().then(result=>{if(result?.user&&result.state&&!result.conflict){state=normalizeState(result.state);writeLocal();render();}else if(result?.user&&!result.state)cloud.save(clone(state));}).catch(e=>setSync('error',e.message));
if('serviceWorker' in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./service-worker.js',{scope:'./'}).catch(()=>{});
