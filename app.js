import { DAYS, METHODS, PHASES } from './curriculum.js';
import {
  createState, normalizeState, dateKey, calendarInfo, tasksForDay, getCurrentTask, getSelectedTask, selectTask,
  questionsFor, resolveTask, startAttempt, beginSelfCheck, setExternalDuration, finishAttempt, completeTask,
  dueReviews, recordReview, getAdaptation, isFreshFullAttempt, setExposure,
} from './model.js';
import { CloudSync } from './cloud.js';

const $ = (s, root = document) => root.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone = v => JSON.parse(JSON.stringify(v));
const subjectName = s => s === 'reading' ? '阅读' : s === 'listening' ? '听力' : s === 'vocabulary' ? '词汇与回忆' : '学习小结';
const kindName = k => ({practice:'专项练习',diagnostic:'阶段诊断',mock:'完整模考',analysis:'精读 / 精听',review:'错题重练',wrapup:'考前巩固'}[k] || '学习任务');
const PREFIX = 'ielts-coach-state-v1:';
const runtime = { user:null, view:'today', methodFilter:'all', reviewFilter:'due', focusAttempt:null, saveTimer:null, toastTimer:null, authMode:'login', conflict:null };
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
function countSummary(s) { return `${Object.keys(s?.completed || {}).length}项完成，${(s?.attempts || []).filter(a => a.completedAt).length}组练习`; }

function fmtTime(seconds) {
  const n = Math.max(0, Math.floor(seconds || 0)); return `${String(Math.floor(n / 60)).padStart(2,'0')}:${String(n % 60).padStart(2,'0')}`;
}
function dayDone(day) { return tasksForDay(state, day).every(t => state.completed[t.id]); }
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
function phaseFor(day) { return PHASES.find(p => day >= p.from && day <= p.to) || PHASES[0]; }
function head(title, description, overline = 'TODAY’S PRACTICE', showDeadline = true) {
  const cal = calendarInfo(state);
  return `<div class="page-heading"><div><div class="overline">${overline}</div><h1>${title}</h1><p>${description}</p></div>${showDeadline ? `<div class="deadline-note">距计划结束<strong>${Math.max(0, cal.remaining)}</strong>天<span>按自己的进度，认真完成。</span></div>` : ''}</div>`;
}
function render() {
  let recovered = false;
  for (const a of state.attempts) {
    if (!a.completedAt && a.recordingMode !== 'self-check') { beginSelfCheck(state,a.id); recovered = true; }
  }
  if (recovered) persist();
  const route = location.hash.slice(1).split('?')[0];
  runtime.view = ['today','roadmap','methods','reviews','records'].includes(route) ? route : 'today';
  const labels = {today:'今日训练',roadmap:'30天路线',methods:'训练方法',reviews:'错题复习',records:'学习记录'};
  $('#breadcrumb').innerHTML = `我的学习空间 <span>/</span> ${labels[runtime.view]}`;
  $('#todayDate').textContent = new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'long'}).format(new Date());
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === runtime.view));
  $('#accountLabel').textContent = runtime.user ? (runtime.user.email?.split('@')[0] || '我的账号') : '登录同步进度';
  $('#avatar').textContent = runtime.user ? (runtime.user.email?.[0] || '我').toUpperCase() : '我';
  const due = dueReviews(state); $('#reviewBadge').textContent = due.length; $('#reviewBadge').hidden = !due.length;
  $('#main').innerHTML = ({today:renderToday,roadmap:renderRoadmap,methods:renderMethods,reviews:renderReviews,records:renderRecords}[runtime.view])();
}
function renderToday() {
  const pending = getCurrentTask(state), selected = getSelectedTask(state);
  const focus = runtime.focusAttempt ? state.attempts.find(a=>a.id===runtime.focusAttempt) : selected ? activeAttempt(selected) || (state.completed[selected.id] ? completedAttempt(selected.id) : null) : null;
  const original = focus ? tasksForDay(state,focus.day).find(t=>t.id===focus.taskId) : selected;
  const task = original ? (focus ? original : resolveTask(state,original)) : null;
  if (!task) return `${head('30天的练习，已经留下了答案。','回看真实成绩与错题，带着清晰的方法上考场。','YOUR NEXT CHAPTER')}<div class="paper empty-state"><span>✓</span><h2>本轮训练已完成</h2><p>练习完成不等于考试保证。最后几套全新试卷的表现，是下一步最有价值的参考。</p><a class="button" href="#records">查看听读成绩</a></div>`;
  const cal = calendarInfo(state), method = METHODS[task.methodId];
  const actualTask = focus ? { ...task, ...focus, id:task.id, type:focus.subject, title:focus.title || task.title, resources:focus.resources } : task;
  const day = actualTask.day, trainingDay = pending?.day || day;
  const heading = day === 1 && task.type === 'reading' && !focus ? '今天，先把这6道题做明白。' : focus?.completedAt ? '每一次复盘，都算数。' : `第${day}天，一步一步往前走。`;
  const overdue = cal.elapsedDay > day && cal.remaining > 0 ? `<div class="banner warn">日历已到第${cal.elapsedDay}天，当前继续第${day}天的未完任务。先接着练，避免把几天作业堆在一起。</div>` : cal.remaining <= 0 ? `<div class="banner warn">30天日历已结束。未完成的任务仍可接着练；根据目前成绩决定下一轮重点。</div>` : '';
  return `${head(heading,'打开你的剑桥真题，阅读、听力按你喜欢的顺序练。')}${overdue}<div class="dashboard"><div>${renderSubjectPicker(trainingDay,actualTask)}${dueReviews(state).length ? `<div class="banner">有 <b>${dueReviews(state).length}</b> 道错题到期了。先回忆，再看依据。<a class="text-button" href="#reviews">去复习 →</a></div>` : ''}<article class="paper lesson"><header class="lesson-top"><div class="lesson-id"><span class="lesson-day">${String(day).padStart(2,'0')}</span><div><small>DAY ${String(day).padStart(2,'0')} / 30</small><strong>${esc(phaseFor(day)?.title || '基础训练')}</strong></div></div><span class="pill">${subjectName(actualTask.type)} · ${actualTask.minutes || task.minutes} min</span></header>${focus ? renderAttempt(actualTask,focus) : ['practice','diagnostic','mock','review'].includes(task.kind) && questionsFor(task).length ? renderTaskIntro(task,method) : renderGeneral(task)}</article></div>${renderAside(trainingDay, actualTask)}</div>`;
}
function taskStatus(task) {
  if (state.completed[task.id]) return '已完成 · 可回看';
  const attempt = [...state.attempts].reverse().find(a=>a.taskId===task.id && !a.completedAt);
  return attempt ? '继续标对错' : state.taskNotes[task.id]?.text ? '继续复盘' : '未开始';
}
function renderSubjectPicker(day, currentTask) {
  const tasks = tasksForDay(state,day).filter(t=>['reading','listening'].includes(t.type));
  return `<section class="subject-picker" aria-label="选择今天的训练科目"><div class="picker-caption">第${day}天 · 先练哪一科，由你决定</div><div class="subject-options">${tasks.map(t=>`<button class="subject-option ${t.id===currentTask.id?'active':''}" data-action="select-task" data-task="${t.id}" aria-pressed="${t.id===currentTask.id}"><span class="subject-option-name">${subjectName(t.type)}<small>${t.minutes} min</small></span><span class="subject-option-status ${state.completed[t.id]?'done':''}">${taskStatus(t)} <span aria-hidden="true">↗</span></span></button>`).join('')}</div><p>在你习惯的网站做题，回来只标对错；两科进度分别保存。</p></section>`;
}
function renderAside(day, currentTask) {
  const tasks = tasksForDay(state,day), sum = tasks.reduce((n,t)=>n+t.minutes,0), done = tasks.filter(t=>state.completed[t.id]).length;
  return `<aside class="right-column"><section class="paper side-panel"><div class="side-title"><h3>今天的训练单</h3><small>${done} / 4 完成</small></div><p class="track-hint">点击选择，四项顺序自由安排。</p><ul class="daily-track">${tasks.map(t=>`<li class="${state.completed[t.id]?'done':''} ${t.id===currentTask.id?'current':''}"><button data-action="select-task" data-task="${t.id}" aria-pressed="${t.id===currentTask.id}"><span class="track-number">${state.completed[t.id]?'✓':t.type==='reading'?'阅':t.type==='listening'?'听':t.type==='vocabulary'?'词':'记'}</span><span>${subjectName(t.type)}</span><span class="track-minutes">${t.minutes} min</span></button></li>`).join('')}</ul></section><section class="paper side-panel"><div class="side-title"><h3>专注，也留出休息</h3></div><div class="budget"><strong>${sum}</strong><span>分钟 · 今日建议净学习</span></div><div class="budget-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></div><p class="offline-note">阅读${tasks[0].minutes}分钟，听力${tasks[1].minutes}分钟，回忆与词汇50分钟，小结10分钟。 每45–60分钟休息10分钟。</p></section><section class="hint-panel"><h3>老师的一句提醒</h3><p>${currentTask.type==='listening'?'先把Part 1的预测、定位和拼写练稳。精听只挑当天规定的短片段，听懂后跟读，不整篇听写。':'先看题目要求，再回原文找依据。认识每个词并不是做对题的前提，读懂答案所在的句子更重要。'}</p><a class="text-button" href="#methods">看看具体怎么练 →</a></section><section class="paper side-panel overview-panel"><div class="side-title"><h3>30天，一天一格</h3><a class="text-button" href="#roadmap">全览 ↗</a></div><div class="day-strip">${DAYS.map(d=>`<button class="day-dot ${dayDone(d.day)?'complete':d.day===day?'active':''}" data-action="preview-day" data-day="${d.day}" aria-label="查看第${d.day}天">${d.day}</button>`).join('')}</div><div class="overview-line"><span>已完成 ${DAYS.filter(d=>dayDone(d.day)).length} 天</span><span>目标：听读 6.5</span></div></section></aside>`;
}
function renderListeningPlan(task) {
  const plan = task.type==='listening' ? task.listeningPlan : null;
  if (!plan || (task.questions && plan.newQuestions>0 && task.questions.length!==plan.newQuestions)) return '';
  const allocations = [['做题 / 起步回顾',plan.firstPassMinutes],['精听 / 分析',plan.reviewMinutes],['拼写与搭配',plan.spellingMinutes],['旧题回忆',plan.recallMinutes]];
  return `<section class="listening-plan"><div class="side-title"><h3>${plan.newQuestions ? `本次新题 ${plan.newQuestions} 道` : '今天复习，消化已经做过的题'}</h3><small>建议 ${task.minutes} 分钟</small></div><p>${esc(plan.instruction)}</p><div class="practice-budget">${allocations.map(([label,minutes])=>`<div><strong>${minutes}<small> min</small></strong><span>${label}</span></div>`).join('')}</div><p class="plan-limit">${plan.segments ? `精听只挑 ${plan.segments} 段，每段不超过 ${plan.segmentSeconds} 秒；每段盲听最多3次，听写 ${plan.dictationSentences} 句。` : '整套当天只归类错因，深度精听安排在复盘日。'}</p></section>`;
}
function renderTaskIntro(task,method) {
  const count = questionsFor(task).length, adapt = getAdaptation(state,task);
  const full = ['mock','diagnostic'].includes(task.kind);
  return `<div class="lesson-body"><div class="subject-label">${task.type==='reading'?'READING':'LISTENING'} <span>·</span> ${kindName(task.kind)}</div><h2>${esc(task.title)}</h2><p class="lead">在你习惯的做题网站或教材上完成，核对答案后回来标记对错。本站记录学习结果，不需要再抄一遍答案。</p><div class="resource-list">${resourcesHtml(task)}</div>${renderListeningPlan(task)}${task.replacement ? `<div class="banner">原计划试卷已见，已换成 ${esc(task.replacement)}。</div>`:''}${task.fresh === false && full ? '<div class="banner warn">这套卷子已练过或看过内容，本次作为复测。</div>':''}${adapt?`<div class="banner warn"><b>为你调整了训练</b><br>${esc(adapt.reason)}<br>先用${adapt.minutes}分钟${esc(adapt.action)}，从本组训练时间中替换。</div>`:''}<div class="section-caption">怎么练这一组</div>${guideHtml(method,true)}<details class="details-block"><summary>看完整方法与示范</summary>${guideHtml(method)}${exampleHtml(method)}</details>${full?`<div class="banner" style="margin-top:20px">${task.type==='reading'?'完整阅读在做题网站按60分钟独立完成。':'完整听力原速播放一次，末尾按机考规则留2分钟核对。'}首次成绩记录订正前的结果，重听、看解析后做对的题另算复习。</div>`:''}</div><footer class="lesson-footer"><small>${count} 道题 · 做完后只标对错</small><button class="button" data-action="start" data-task="${task.id}">我已做完，记录对错 <span>→</span></button></footer>`;
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
  return `<div class="lesson-body"><div class="subject-label">${subjectName(attempt.subject)} · 逐题记录${attempt.redo?' · 重做':''}</div><h2>${esc(attempt.title || task.title)}</h2><div class="resource-list">${resourcesHtml(task)}</div><p class="lead">对照你做题网站或教材的批改结果，标记第一次作答的对错。漏答、拼写或字数不符也记为错误。</p><div class="marking-toolbar"><span><b>${marked} / ${attempt.questions.length}</b> 已标记 · ${wrong} 道错误</span><button class="button secondary small" data-action="grade-rest" ${marked===attempt.questions.length?'disabled':''}>其余未标记题全部正确</button></div><div class="selfcheck-grid">${attempt.questions.map((q,i)=>renderGrade(q,i)).join('')}</div><div class="subheading">补充记录 <small class="muted">选填</small></div><label class="external-duration">本次做题用时（分钟）<input type="number" min="0" max="1440" step="0.5" data-duration="${attempt.id}" value="${attempt.durationProvided?Math.round(attempt.elapsedSeconds/60*10)/10:''}" placeholder="不填也可以保存成绩"></label><details class="details-block"><summary>记录一个收获或主要问题（选填）</summary><label style="margin-top:12px">本组笔记<textarea data-attempt-note="${attempt.id}" placeholder="例如：改口后的信息才是答案；下次检查单复数。">${esc(attempt.note || '')}</textarea></label></details>${full?`<div class="form-meta"><input id="normalConditions" type="checkbox" ${attempt.normalConditions===true?'checked':''}><label for="normalConditions">本次是未见过的完整卷，已按考试条件独立完成（${attempt.subject==='reading'?'阅读60分钟':'听力原速一次，末尾2分钟核对'}），记录的是订正前成绩。未勾选则保存为普通练习。</label></div>`:''}</div><footer class="lesson-footer"><small>对错自动保存，错因和笔记选填</small><button class="button" data-action="finish-attempt">保存本组成绩 <span>→</span></button></footer>`;
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
  return `<div class="lesson-body"><div class="subject-label">${subjectName(a.subject)} · 本组已完成</div><h2>做完，也弄懂一点。</h2><div class="result-score">${correct}<small> / ${total}</small></div><p class="lead">${a.redo?'重做成绩':isFreshFullAttempt(a)?'全新完整卷 · 首次成绩':'专项 / 已见内容练习'} · ${attemptDuration(a)}</p><div class="result-note">${wrong?`${wrong}道错题已加入复习，安排在次日、3天后和7天后回忆。`:'这组全部正确。下次继续用原文或音频证据验证自己的判断。'}${total<40?'<br>专项成绩用于观察题型进步，不换算雅思分数。':''}${total===40?'<br>训练争取稳定30/40。正式分数依试卷换算，不作提分保证。':''}</div>${a.reviewScheduleNote?`<p class="lead">${esc(a.reviewScheduleNote)}</p>`:''}${a.note?`<div class="section-caption">这次记住的事</div><p class="lead">${esc(a.note)}</p>`:''}<details class="details-block"><summary>回看本组对错与复盘</summary>${a.questions.map(q=>`<div class="review-answer"><b>${esc(q.label)} · ${q.correct?'✓':'×'}</b>${q.answer?`<br><span lang="en">原作答：${esc(q.answer)}</span>`:''}${!q.correct?`<br>${esc(q.cause || '待分析')}<br>${esc(q.evidence || '回到对应题目的解析或音频复习即可。')}`:''}</div>`).join('')}</details></div><footer class="lesson-footer"><a class="text-button" href="#records">查看学习记录 ↗</a><div class="button-row" style="margin:0"><button class="button secondary small" data-action="redo-attempt" data-id="${esc(a.id)}">重做这一组</button><button class="button" data-action="next">继续下一项 →</button></div></footer>`;
}
function renderGeneral(task) {
  const note = state.taskNotes?.[task.id] || {};
  const source = state.attempts.find(a=>a.id===task.analysisOf&&a.completedAt) || (task.sourceDay ? state.attempts.find(a=>a.day===task.sourceDay&&a.subject===task.type&&a.completedAt&&!a.redo) : null);
  let content = '';
  if (task.type==='vocabulary') {
    const words = state.vocabulary.filter(w=>w.day===task.day);
    content = `<div class="banner">先用20分钟回忆到期错题，再用30分钟整理当天真题中的词汇。新增最多20个，优先记能再次遇到的词和搭配。</div>${dueReviews(state).length?`<a class="button secondary small" href="#reviews">复习 ${dueReviews(state).length} 道到期错题 →</a>`:'<p class="lead">今天暂时没有到期错题，可以回忆刚才的原文依据或听力关键词。</p>'}<div class="subheading">今天记住的词与替换</div><div class="vocab-tags">${words.map(w=>`<span lang="en">${esc(w.word)} · ${esc(w.meaning)} <button class="text-button" data-action="delete-word" data-id="${esc(w.id)}" aria-label="删除${esc(w.word)}">×</button></span>`).join('') || '<p class="lead">从今天的真题中挑词，每个词都带上意思或同义替换。</p>'}</div><form id="vocabForm" class="form-stack" style="margin-top:20px"><div class="form-grid"><label>单词 / 搭配<input name="word" maxlength="100" autocomplete="off" placeholder="例如：increase" required></label><label>含义 / 同义替换<input name="meaning" maxlength="200" placeholder="例如：增加；grow / rise" required></label></div><label>例句或题目出处<input name="example" maxlength="400" placeholder="例如：剑17 T1 Q1；原文中的用法"></label><button class="button secondary small" type="submit" ${words.length>=20?'disabled':''}>添加词汇（${words.length}/20）</button></form>`;
  } else if (task.type==='reflection') {
    const ref = state.reflections[task.day] || {};
    content = `<div class="banner">今天的最后10分钟。写下一个具体收获和一个下一次要改变的动作，比只勾选“学完了”更有用。</div><div class="note-form"><label>今天真正弄懂了什么？<textarea data-reflection="learned" placeholder="例如：NOT GIVEN不是我不知道，而是原文没有足够信息。">${esc(ref.learned || '')}</textarea></label><label>下一次先改哪一个动作？<textarea data-reflection="next" placeholder="例如：先圈字数要求，检查答案单复数。">${esc(ref.next || '')}</textarea></label></div>`;
  } else if (task.kind==='analysis') {
    const wrong = source?.questions.filter(q=>q.correct===false) || [];
    const checklist = task.type==='reading' ? ['找到错题对应的原文依据，分清定位、理解和规则问题。','精读2–3个关键段落，拆解影响答案的长句。','整理至少3组题干与原文的同义替换，合上书再解释一次。'] : [`挑${task.listeningPlan?.segments || 2}个困难片段，每段不超过${task.listeningPlan?.segmentSeconds || 15}秒；盲听最多3次再看文本。`,`理解后跟读，只听写${task.listeningPlan?.dictationSentences || 1}句关键句，不整段抄写。`,'合上文本原速重听，归类听辨、定位、干扰项或拼写问题。'];
    content = `${source?`<div class="result-note">复盘第${task.sourceDay}天的${subjectName(task.type)}：${source.score?.correct ?? source.correctCount ?? 0} / ${source.questions.length}。先从失分最多的地方开始。</div>`:'<div class="banner warn">还没有找到对应的练习成绩。请使用当天实际做过的试卷，按下面步骤复盘并留下记录。</div>'}<div class="checklist">${checklist.map((s,i)=>`<label><input type="checkbox" data-check="${i}" ${note.checks?.[i]?'checked':''}><span>${s}</span></label>`).join('')}</div>${wrong.length?`<details class="details-block"><summary>回看 ${wrong.length} 道错题</summary>${wrong.map(q=>`<div class="review-answer"><b>${esc(q.label)} · ${esc(q.cause || '待分析')}</b><br>${esc(q.evidence || '暂未记录依据，请回到原文或音频寻找。')}</div>`).join('')}</details>`:''}<div class="subheading">复盘笔记（选填）</div><label>具体依据、同义替换或听辨发现<textarea data-task-note="${task.id}" placeholder="把发现写成下一次可执行的动作。">${esc(note.text || '')}</textarea></label>`;
  } else if (task.kind==='review') {
    content = `<div class="banner">当前没有足够的${subjectName(task.type)}错题需要重做。只复习已有内容，剩余时间回看同义替换，不凑题量。</div><a class="button secondary" href="#reviews">打开错题本</a><label style="margin-top:20px">这次复习发现<textarea data-task-note="${task.id}">${esc(note.text || '')}</textarea></label>`;
  } else {
    content = `<div class="banner">今天轻量复习，不再靠大量刷题获得安全感。用真实模考成绩判断自己的节奏。</div><div class="checklist">${(task.type==='reading'?['回看常错的题型规则、字数和拼写。','确定做题顺序；阅读60分钟包含填答，没有额外转写时间。','回忆最常见的同义替换，检查机考键入习惯。']:['回看数字、日期、单复数及常错拼写。','记住原速播放一次，跟丢一题就准备下一题。','确认机考末尾核对规则；复习常见改口和干扰信号。']).map((s,i)=>`<label><input type="checkbox" data-check="${i}" ${note.checks?.[i]?'checked':''}><span>${s}</span></label>`).join('')}</div><label>带进考场的一句提醒（选填）<textarea data-task-note="${task.id}">${esc(note.text || '')}</textarea></label>`;
  }
  const adapt = getAdaptation(state,task);
  return `<div class="lesson-body"><div class="subject-label">${subjectName(task.type)} · ${kindName(task.kind)}</div><h2>${esc(task.title)}</h2>${adapt?`<div class="banner warn">先安排${adapt.minutes}分钟补强：${esc(adapt.action)}。${esc(adapt.reason)}</div>`:''}${renderListeningPlan(task)}<div style="margin-top:20px">${content}</div></div><footer class="lesson-footer"><small>认真留下记录，再翻到下一项。</small><button class="button" data-action="complete-general" data-task="${task.id}">完成这一项 →</button></footer>`;
}
function renderRoadmap() {
  const current = getCurrentTask(state)?.day;
  return `${head('30天，每一天都有方向。','先补基础，再练题型，最后用全新试卷检验。','YOUR 30-DAY ROUTE')}<div class="banner">日历是一条路线，不是跳关按钮。今日任务会接续未完成的位置；可以查看后面的安排。</div>${PHASES.map(p=>`<section class="route-section"><div class="phase-heading"><h2>${esc(p.title)}</h2><small>第${p.from}–${p.to}天 · ${esc(p.description)}</small></div><div class="roadmap-grid">${DAYS.filter(d=>d.day>=p.from&&d.day<=p.to).map(d=>`<button class="day-card ${d.day===current?'current-day':''}" data-action="preview-day" data-day="${d.day}"><div class="day-card-head"><strong>${String(d.day).padStart(2,'0')}</strong><span class="pill ${dayDone(d.day)?'green':d.day===current?'':'neutral'}">${dayDone(d.day)?'已完成':d.day===current?'进行中':'查看安排'}</span></div><h3>${esc(d.title)}</h3><p><b>阅读</b>${esc(d.reading.title)}</p><p><b>听力</b>${esc(d.listening.title)}</p><div class="day-card-footer">${tasksForDay(state,d.day).map(t=>`<i class="${state.completed[t.id]?'done':''}"></i>`).join('')}</div></button>`).join('')}</div></section>`).join('')}`;
}
function renderMethods() {
  const methods = Object.values(METHODS).filter(m=>runtime.methodFilter==='all'||m.subject===runtime.methodFilter);
  return `${head('知道怎么练，才不白做题。','先掌握方法，再用真题验证。以下小示范均为原创，非剑桥题文。','PRACTICE WITH A METHOD',false)}<div class="method-tabs">${[['all','全部方法'],['reading','阅读'],['listening','听力']].map(([id,label])=>`<button class="filter-button ${runtime.methodFilter===id?'active':''}" data-action="method-filter" data-filter="${id}">${label}</button>`).join('')}</div><div class="method-grid">${methods.map(m=>`<article class="paper method-card"><span class="pill">${subjectName(m.subject)}</span><h3 style="margin-top:12px">${esc(m.title)}</h3><p>${esc(m.intro)}</p><details><summary>展开训练步骤与原创示范</summary><div style="margin-top:17px">${guideHtml(m)}${exampleHtml(m)}${m.pitfalls?.length?`<ul class="pitfalls">${m.pitfalls.map(t=>`<li>${esc(t)}</li>`).join('')}</ul>`:''}</div></details></article>`).join('')}</div>`;
}
function renderReviews() {
  const due = dueReviews(state);
  const all = state.reviews || [];
  const list = runtime.reviewFilter==='all' ? all : due;
  return `${head('把错过的，再做明白。','先遮住依据，回忆为什么选；再翻回教材验证。','RECALL · VERIFY · REMEMBER',false)}<div class="method-tabs"><button class="filter-button ${runtime.reviewFilter==='due'?'active':''}" data-action="review-filter" data-filter="due">到期复习 ${due.length}</button><button class="filter-button ${runtime.reviewFilter==='all'?'active':''}" data-action="review-filter" data-filter="all">全部错题 ${all.length}</button></div>${list.length?list.map(r=>`<article class="paper review-card"><div class="review-card-head"><div><span class="pill ${r.subject==='reading'?'':'neutral'}">${subjectName(r.subject)}</span><strong style="margin-left:9px">${esc(r.label)}</strong></div><span class="pill ${r.completed?'green':'neutral'}">${r.completed?'已完成三轮':`第${(r.stage||0)+1}轮 · ${esc(r.dueDate)}`}</span></div><p>失分原因：${esc(r.cause || '待分析')} · 累计出错 ${r.failures || 1} 次</p><details><summary>我已回忆，查看复习提醒</summary><div class="review-answer">${r.answer?`<b>当时作答：</b><span lang="en">${esc(r.answer)}</span><br>`:''}<b>复习提醒 / 依据：</b>${esc(r.evidence || '回到做题网站或教材，查看这道题的依据。')}</div></details><label style="margin-top:12px">补充一句复习提醒（选填）<input data-review-evidence="${esc(r.id)}" value="${esc(r.evidence || '')}" placeholder="例如：这题因改口听错，下次等完整句"></label>${!r.completed?`<div class="button-row"><button class="button small" data-action="review-pass" data-id="${esc(r.id)}" ${r.dueDate>dateKey()?'disabled title="未到复习日，可先回看依据"':''}>${r.dueDate>dateKey()?'未到复习日，先回看':'回忆正确，安排下一轮'}</button><button class="button secondary small" data-action="review-fail" data-id="${esc(r.id)}">仍不熟，明天再来</button></div>`:''}</article>`).join(''):`<div class="paper empty-state"><span>↺</span><h2>${all.length?'今天的到期错题已复习完':'错题本，从一次认真批改开始'}</h2><p>${all.length?'按1、3、7天的间隔回忆。现在可以继续今日训练。':'完成一组真题并标出对错，错题就会按题号出现在这里。'}</p><a class="button" href="#today">继续今日训练 →</a></div>`}`;
}
function renderRecords() {
  const attempts = state.attempts.filter(a=>a.completedAt).slice().reverse();
  const full = attempts.filter(a=>isFreshFullAttempt(a)).slice().reverse();
  const done = Object.keys(state.completed).length;
  const latest = subject=>attempts.find(a=>a.subject===subject&&isFreshFullAttempt(a));
  const rawScore = a=>a ? `${a.score?.correct ?? a.correctCount ?? 0}/40` : '—';
  return `${head('用真实记录，看见进步。','首次与重做分开，专项与完整卷分开。没有练习数据时不生成示例成绩。','YOUR LEARNING RECORD',false)}<div class="metrics"><div class="metric"><small>阅读 · 最近全新完整卷</small><strong>${rawScore(latest('reading'))}</strong><span>训练目标稳定30/40</span></div><div class="metric"><small>听力 · 最近全新完整卷</small><strong>${rawScore(latest('listening'))}</strong><span>训练目标稳定30/40</span></div><div class="metric"><small>已完成训练</small><strong>${done}<span style="font-size:15px;color:#97a4b8"> / 120</span></strong><span>${DAYS.filter(d=>dayDone(d.day)).length}个训练日已完成</span></div><div class="metric"><small>个人词汇积累</small><strong>${state.vocabulary.length}</strong><span>来自自己的真题与同义替换</span></div></div>${full.length?`<section class="paper chart-panel"><div class="side-title"><h3>全新完整卷 · 首次正确题数</h3><small>满分40 · 深蓝阅读 / 浅蓝听力</small></div><div class="score-chart">${full.map(a=>{const correct=a.score?.correct??a.correctCount??0;return `<div class="score-column ${a.subject}"><strong>${correct}</strong><div class="bar" style="height:${correct/40*125}px"></div><small>D${a.day} · ${subjectName(a.subject)}</small></div>`;}).join('')}</div></section>`:''}<div class="button-row" style="margin:0 0 20px"><button class="button secondary small" data-action="export">导出学习备份</button><button class="button secondary small" data-action="import">导入备份</button><button class="text-button" data-action="settings">日期与已做试卷</button></div>${attempts.length?`<section class="paper records-table-wrap"><table class="records-table"><thead><tr><th>训练</th><th>科目</th><th>成绩</th><th>记录类型</th><th>用时</th><th>查看</th></tr></thead><tbody>${attempts.map(a=>`<tr><td>第${a.day}天 · ${esc(a.title || kindName(a.kind))}</td><td>${subjectName(a.subject)}</td><td><strong>${a.score?.correct??a.correctCount??0} / ${a.questions.length}</strong></td><td><span class="pill ${isFreshFullAttempt(a)?'green':'neutral'}">${a.redo?'重做':a.questions.length===40?(isFreshFullAttempt(a)?'全新完整卷':'完整卷练习'):'专项练习'}</span></td><td>${a.recordingMode==='self-check'&&!a.durationProvided?'未记录':fmtTime(a.elapsedSeconds)}</td><td><button class="text-button" data-action="view-attempt" data-id="${esc(a.id)}">回看 ↗</button></td></tr>`).join('')}</tbody></table></section>`:`<div class="paper empty-state"><span>▥</span><h2>第一份成绩，来自第一组练习</h2><p>完成作答和教材批改后，网站会记录结果。专项成绩只反映这组练习，不直接估算雅思分数。</p><a class="button" href="#today">开始今日训练 →</a></div>`}<div class="banner" style="margin-top:22px">3.5是起点自评，6.5是冲刺目标。正式分数取决于实际考试；请结合完整新卷表现判断准备程度。</div>`;
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
  openModal(`<h2>让计划贴合你的起点</h2><p>已经做过、看过原文、答案或听力文本的试卷，请按科目勾选。网站会为诊断和模考优先换新卷。</p><label>30天计划开始日期<input id="startDateInput" type="date" value="${esc(state.profile.startDate)}"></label><div class="divider"></div>${['reading','listening'].map(subject=>`<h3 style="margin-top:18px">${subjectName(subject)} · 已见试卷</h3><div class="exposure-grid">${[15,16,17,18,19,20].map(book=>`<div class="exposure-book"><strong>剑${book}</strong>${[1,2,3,4].map(test=>`<label><input type="checkbox" data-exposure="${subject}" data-book="${book}" data-test="${test}" ${state.exposures[`${subject}-${book}-${test}`]?.seen?'checked':''}>Test ${test}</label>`).join('')}</div>`).join('')}</div>`).join('')}<div class="banner" style="margin-top:20px">新卷替补顺序：剑19 T3、T4 → 剑20 T1–T4。已练内容会持续标为已见；两科分别判断。</div><div class="button-row"><button class="button" data-action="save-settings">保存设置</button><button class="button secondary" data-action="close-modal">返回训练</button></div>`);
}
function previewDay(day) {
  const d = DAYS[day-1]; if (!d) return;
  const current = getCurrentTask(state)?.day;
  openModal(`<div class="overline">DAY ${String(day).padStart(2,'0')} / 30</div><h2>${esc(d.title)}</h2><p>${esc(phaseFor(day)?.title || '')} · ${dayDone(day)?'已完成':day===current?'当前训练日':'路线预览'}</p>${['reading','listening'].map(subject=>{const t={...d[subject],type:subject};return `<div class="subheading">${subjectName(subject)} · ${esc(t.title)}</div><div class="resource-list">${resourcesHtml(t)}</div>${!t.resources.length?`<p class="lead">${t.kind==='analysis'?`复盘第${t.sourceDay}天实际做过的试卷。`:'回看错题与已经记录的方法。'}</p>`:''}`;}).join('')}<div class="banner">另有20分钟错题回忆、30分钟真题词汇、10分钟小结。阅读${tasksForDay(state,day)[0].minutes}分钟，听力${tasksForDay(state,day)[1].minutes}分钟。</div><div class="button-row"><button class="button" data-action="return-today">${day===current?'继续今天的训练':'返回当前任务'} →</button></div>`);
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
    if(action==='select-task') {
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
    } else if(action==='next'){runtime.focusAttempt=null;state.selectedTaskId=getCurrentTask(state)?.id||null;persist();render();window.scrollTo({top:0,behavior:'smooth'});}
    else if(action==='complete-general'){
      const t=getSelectedTask(state);if(!t||t.id!==el.dataset.task)return;
      if(t.type==='reflection') {
        const n=state.reflections[t.day];if(!n?.learned?.trim()||!n?.next?.trim()){toast('请写下一个收获和下一次要改的动作。');return;}
      } else if(t.type==='vocabulary'&&!state.vocabulary.some(w=>w.day===t.day)){toast('先从今天的真题中记录至少一个词或同义替换。');return;}
      else if(['analysis','wrapup'].includes(t.kind)){
        const n=state.taskNotes[t.id];if(!n?.checks?.every(Boolean)||n.checks.length<3){toast('完成三项回顾后即可保存，笔记可以不填。');return;}
      }
      completeTask(state,t.id);state.selectedTaskId=getCurrentTask(state)?.id||null;persist();render();window.scrollTo({top:0,behavior:'smooth'});toast('已完成，也可以自由选择下一科。');
    } else if(action==='method-filter'){runtime.methodFilter=el.dataset.filter;render();}
    else if(action==='review-filter'){runtime.reviewFilter=el.dataset.filter;render();}
    else if(action==='review-pass'||action==='review-fail'){
      recordReview(state,el.dataset.id,action==='review-pass');persist();render();toast(action==='review-pass'?'已安排下一轮复习。':'明天再回忆这道题。');
    } else if(action==='preview-day')previewDay(Number(el.dataset.day));
    else if(action==='return-today'){closeModal();location.hash='today';runtime.focusAttempt=null;render();}
    else if(action==='account')authModal();
    else if(action==='cloud-help')openModal(`<h2>一次性开启跨设备同步</h2><p>账号功能已接入，需要在你现有的云服务里创建本站独立学习表。本机练习与备份现在就能使用。</p><ol class="step-guide"><li><span>下载下面的建表脚本，打开对应 Supabase 项目的 SQL Editor。</span></li><li><span>粘贴脚本并运行一次，它只创建本站学习表和版本检查函数。</span></li><li><span>回到网站，使用同一邮箱在手机、电脑登录，再点击“读取云端最新记录”。</span></li></ol><div class="button-row"><a class="button" href="./supabase-setup.sql" download>下载建表脚本</a><a class="button secondary" href="./README.md" target="_blank">打开部署说明</a></div>`);
    else if(action==='auth-tab'){runtime.authMode=el.dataset.tab;authModal();}
    else if(action==='close-modal')closeModal();
    else if(action==='settings')settingsModal();
    else if(action==='save-settings'){
      const v=$('#startDateInput').value;if(!/^\d{4}-\d{2}-\d{2}$/.test(v)){toast('请选择有效开始日期。');return;}
      state.profile.startDate=v;
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
    } else if(action==='delete-word'){
      state.vocabulary=state.vocabulary.filter(w=>w.id!==el.dataset.id);persist();render();
    }
  } catch(err){toast(err.message || '操作暂未完成，记录已保留。');console.error(err);}
});

document.addEventListener('input', e=>{
  const el=e.target,a=currentFocusedAttempt(),t=currentResolvedTask();
  if(el.dataset.duration&&a){try{setExternalDuration(state,a.id,el.value.trim()===''?null:Number(el.value)*60);}catch{return;}}
  else if(el.dataset.evidence!==undefined&&a)a.questions[Number(el.dataset.evidence)].evidence=el.value;
  else if(el.dataset.attemptNote&&a)a.note=el.value;
  else if(el.dataset.taskNote){state.taskNotes[el.dataset.taskNote]??={checks:[false,false,false],text:''};state.taskNotes[el.dataset.taskNote].text=el.value;}
  else if(el.dataset.reflection&&t){state.reflections[t.day]??={learned:'',next:''};state.reflections[t.day][el.dataset.reflection]=el.value;}
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
  if(e.target.id==='vocabForm'){
    e.preventDefault();const t=currentResolvedTask();if(!t||t.type!=='vocabulary')return;
    const data=new FormData(e.target);if(state.vocabulary.filter(w=>w.day===t.day).length>=20){toast('每天最多新增20个词，先把已有的记住。');return;}
    const word=String(data.get('word')).trim(),meaning=String(data.get('meaning')).trim();if(!word||!meaning)return;
    state.vocabulary.push({id:crypto.randomUUID(),day:t.day,word,meaning,example:String(data.get('example')).trim(),createdAt:new Date().toISOString()});persist();render();toast('已记下，记得回到原句里复习。');
  } else if(e.target.id==='authForm'){
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
