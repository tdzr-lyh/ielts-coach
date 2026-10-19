import { DAYS, METHODS, PHASES } from './curriculum.js';
import {
  createState, normalizeState, dateKey, calendarInfo, tasksForDay, getCurrentTask,
  questionsFor, resolveTask, startAttempt, submitAttempt, finishAttempt, completeTask,
  dueReviews, recordReview, getAdaptation, getStats, setExposure,
} from './model.js';
import { CloudSync } from './cloud.js';

const $ = (s, root = document) => root.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone = v => JSON.parse(JSON.stringify(v));
const subjectName = s => s === 'reading' ? '阅读' : s === 'listening' ? '听力' : s === 'vocabulary' ? '词汇与回忆' : '学习小结';
const kindName = k => ({practice:'专项练习',diagnostic:'阶段诊断',mock:'完整模考',analysis:'精读 / 精听',review:'错题重练',wrapup:'考前巩固'}[k] || '学习任务');
const PREFIX = 'ielts-coach-state-v1:';
const runtime = { user:null, view:'today', methodFilter:'all', reviewFilter:'due', focusAttempt:null, timer:null, timerBase:0, timerStart:0, saveTimer:null, toastTimer:null, authMode:'login', conflict:null };
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
    pauseTimer(); clearTimeout(runtime.saveTimer); runtime.user = user; runtime.focusAttempt = null;
    state = readLocal(user?.id || 'guest'); render();
  },
  onRemote(remote) {
    if (!remote) return;
    pauseTimer(); state = normalizeState(remote); runtime.focusAttempt = null; writeLocal(); render();
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
    if (found) return found;
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
    const end = a.checkDeadline || (a.subject === 'reading' && ['diagnostic','mock'].includes(a.kind) ? a.deadline : null);
    if (!a.submittedAt && end && new Date(end).getTime() <= Date.now()) {
      submitAttempt(state,a.id); recovered = true;
    }
  }
  if (recovered) { writeLocal(); toast('考试计时已结束，已锁定截止前保存的答案，请对照教材批改。'); }
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
  updateTimerDom();
  const active = currentFocusedAttempt();
  if(active && !active.submittedAt && (active.checkDeadline || active.deadline) && !runtime.timer) startTimer();
}
function renderToday() {
  const pending = getCurrentTask(state);
  const focus = runtime.focusAttempt ? state.attempts.find(a=>a.id===runtime.focusAttempt) : pending ? activeAttempt(pending) : null;
  const original = focus ? tasksForDay(state,focus.day).find(t=>t.id===focus.taskId) : pending;
  const task = original ? (focus ? original : resolveTask(state,original)) : null;
  if (!task) return `${head('30天的练习，已经留下了答案。','回看真实成绩与错题，带着清晰的方法上考场。','YOUR NEXT CHAPTER')}<div class="paper empty-state"><span>✓</span><h2>本轮训练已完成</h2><p>练习完成不等于考试保证。最后几套全新试卷的表现，是下一步最有价值的参考。</p><a class="button" href="#records">查看听读成绩</a></div>`;
  const cal = calendarInfo(state), method = METHODS[task.methodId];
  const actualTask = focus ? { ...task, ...focus, type:focus.subject, title:focus.title || task.title, resources:focus.resources } : task;
  const day = actualTask.day;
  const heading = day === 1 && task.type === 'reading' && !focus ? '今天，先把这6道题做明白。' : focus?.completedAt ? '每一次复盘，都算数。' : `第${day}天，一步一步往前走。`;
  const overdue = cal.elapsedDay > day && cal.remaining > 0 ? `<div class="banner warn">日历已到第${cal.elapsedDay}天，当前继续第${day}天的未完任务。先接着练，避免把几天作业堆在一起。</div>` : cal.remaining <= 0 ? `<div class="banner warn">30天日历已结束。未完成的任务仍可接着练；根据目前成绩决定下一轮重点。</div>` : '';
  return `${head(heading,'打开你的剑桥真题，今天的安排和方法都在这里。')}${overdue}<div class="dashboard"><div>${dueReviews(state).length ? `<div class="banner">有 <b>${dueReviews(state).length}</b> 道错题到期了。先回忆，再看依据。<a class="text-button" href="#reviews">去复习 →</a></div>` : ''}<article class="paper lesson"><header class="lesson-top"><div class="lesson-id"><span class="lesson-day">${String(day).padStart(2,'0')}</span><div><small>DAY ${String(day).padStart(2,'0')} / 30</small><strong>${esc(phaseFor(day)?.title || '基础训练')}</strong></div></div><span class="pill">${subjectName(actualTask.type)} · ${actualTask.minutes || task.minutes} min</span></header>${focus ? renderAttempt(actualTask,focus) : ['practice','diagnostic','mock','review'].includes(task.kind) && questionsFor(task).length ? renderTaskIntro(task,method) : renderGeneral(task)}</article></div>${renderAside(day, pending || task)}</div>`;
}
function renderAside(day, currentTask) {
  const tasks = tasksForDay(state,day), sum = tasks.reduce((n,t)=>n+t.minutes,0), done = tasks.filter(t=>state.completed[t.id]).length;
  return `<aside class="right-column"><section class="paper side-panel"><div class="side-title"><h3>今天的训练单</h3><small>${done} / 4 完成</small></div><ol class="daily-track">${tasks.map((t,i)=>`<li class="${state.completed[t.id]?'done':t.id===currentTask.id?'current':''}"><span class="track-number">${state.completed[t.id]?'✓':i+1}</span><span>${subjectName(t.type)}</span><span class="track-minutes">${t.minutes} min</span></li>`).join('')}</ol></section><section class="paper side-panel"><div class="side-title"><h3>专注，也留出休息</h3></div><div class="budget"><strong>${sum/60 === 3.5 ? '3.5' : sum/60}</strong><span>小时 · 分两次练完</span></div><div class="budget-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></div><p class="offline-note">${day<=3?'前3天适应节奏，听读各75分钟。':'听读各90分钟，回忆与词汇50分钟，小结10分钟。'} 每45–60分钟休息10分钟。</p></section><section class="hint-panel"><h3>老师的一句提醒</h3><p>${currentTask.type==='listening'?'第一遍按原速只听一次，记录真实答案。精听时只挑3–5个困难片段，先盲听，再对照文本。':'先看题目要求，再回原文找依据。认识每个词并不是做对题的前提，读懂答案所在的句子更重要。'}</p><a class="text-button" href="#methods">看看具体怎么练 →</a></section><section class="paper side-panel overview-panel"><div class="side-title"><h3>30天，一天一格</h3><a class="text-button" href="#roadmap">全览 ↗</a></div><div class="day-strip">${DAYS.map(d=>`<button class="day-dot ${dayDone(d.day)?'complete':d.day===day?'active':''}" data-action="preview-day" data-day="${d.day}" aria-label="查看第${d.day}天">${d.day}</button>`).join('')}</div><div class="overview-line"><span>已完成 ${DAYS.filter(d=>dayDone(d.day)).length} 天</span><span>目标：听读 6.5</span></div></section></aside>`;
}
function renderTaskIntro(task,method) {
  const count = questionsFor(task).length, adapt = getAdaptation(state,task);
  const full = ['mock','diagnostic'].includes(task.kind);
  return `<div class="lesson-body"><div class="subject-label">${task.type==='reading'?'READING':'LISTENING'} <span>·</span> ${kindName(task.kind)}</div><h2>${esc(task.title)}</h2><p class="lead">${full?'保持真实考试条件，先完成一次完整练习，再核对答案。':'先独立完成这一小组。不会的可以留空或标记，记录真实用时。'}</p><div class="resource-list">${resourcesHtml(task)}</div>${task.replacement ? `<div class="banner">原计划试卷已见，已换成 ${esc(task.replacement)}。</div>`:''}${task.fresh === false && full ? '<div class="banner warn">这套卷子已练过或看过内容，本次标为复测，不作为全新模考成绩。</div>':''}${adapt?`<div class="banner warn"><b>为你调整了训练</b><br>${esc(adapt.reason)}<br>先用${adapt.minutes}分钟${esc(adapt.action)}，从本组训练时间中替换，不额外加量。</div>`:''}<div class="section-caption">这一次，按这几步做</div>${guideHtml(method,true)}<details class="details-block"><summary>看完整方法与示范</summary>${guideHtml(method)}${exampleHtml(method)}</details>${full&&task.type==='listening'?'<div class="banner" style="margin-top:20px">使用教材自己的音频，整套原速播放一次。音频结束后点击按钮，开始2分钟核对；不安排纸笔考试的10分钟誊写。</div>':''}</div><footer class="lesson-footer"><small>${count} 道题 · ${full&&task.type==='reading'?'60分钟倒计时':'保存首次答案，再对照教材批改'}</small><button class="button" data-action="start" data-task="${task.id}">开始这一组 <span>→</span></button></footer>`;
}
function exampleHtml(method) {
  if (!method?.example) return '';
  return `<div class="method-example"><b>原创方法示范 · 非剑桥真题</b><p class="english" lang="en">${esc(method.example.prompt)}</p><p>${esc(method.example.explanation)}</p></div>`;
}
function renderAttempt(task,attempt) {
  if (attempt.completedAt) return renderResult(task,attempt);
  const submitted = Boolean(attempt.submittedAt);
  const methods = METHODS[task.methodId];
  return `<div class="lesson-body"><div class="subject-label">${subjectName(attempt.subject)} · ${submitted?'第2步 / 对照教材批改':'第1步 / 独立作答'}${attempt.redo?' · 重做':''}</div><h2>${esc(attempt.title || task.title)}</h2><div class="resource-list">${resourcesHtml(task)}</div>${submitted ? `<div class="banner">首次答案已锁定。现在翻开教材答案，逐题标记对错；网站不会自动批改。空着或超出字数要求的答案也应标错。</div><div class="grading-list">${attempt.questions.map((q,i)=>renderGrade(q,i)).join('')}</div><div class="subheading">本组复盘</div><label>最卡在哪里？找到哪些同义替换？<textarea data-attempt-note="${attempt.id}" placeholder="例如：题干 increased 对应原文 grew；答案单复数漏看。">${esc(attempt.note || '')}</textarea></label>${['diagnostic','mock'].includes(attempt.kind)?`<div class="form-meta"><input id="normalConditions" type="checkbox" ${attempt.normalConditions===true?'checked':''}><label for="normalConditions">本次按考试条件独立完成（阅读60分钟；听力原速一次、末尾2分钟核对）。未确认时保存为普通练习。</label></div>`:''}<div class="form-meta"><input id="reviewChecked" type="checkbox" ${attempt.reviewChecked?'checked':''}><label for="reviewChecked">我已对照教材批改，并回看错题的原文 / 音频依据。</label></div>` : `<p class="lead">在纸书上读题，在这里输入答案练习键入。可以留空；提交后记录为首次答案。请按教材题干的字数要求填写。</p><div class="timer-bar"><div><b>${attempt.subject==='reading'&&attempt.questions.length===40?'阅读模考 · 60分钟':attempt.checkDeadline?'音频已结束 · 核对答案':'专注计时'}</b><br><small id="timerCaption">${runtime.timer?'正在计时':'已暂停，可继续'}</small></div><span class="timer-value" id="timerValue">${fmtTime(attempt.elapsedSeconds)}</span><button class="text-button" data-action="timer-toggle">${runtime.timer?'暂停':'继续'}</button></div>${attempt.subject==='listening'&&attempt.questions.length===40?`<div class="banner">请播放自己的整套真题音频。${attempt.checkDeadline?'正在进行末尾2分钟核对。':'音频原速一次播放完毕后，再点击下面按钮。'}</div>${!attempt.checkDeadline?'<button class="button secondary small" data-action="listening-check">音频已结束，开始2分钟核对</button>':''}`:''}<div class="question-grid">${attempt.questions.map((q,i)=>`<div class="answer-field"><label for="answer-${i}">${esc(q.label)}</label><input id="answer-${i}" lang="en" autocomplete="off" spellcheck="false" data-answer="${i}" value="${esc(q.answer)}" placeholder="输入答案" aria-label="${esc(q.label)}的答案"></div>`).join('')}</div><details class="details-block"><summary>卡住了？回看本题型方法</summary>${guideHtml(methods)}</details>`}</div><footer class="lesson-footer"><small>${submitted?`${attempt.questions.filter(q=>typeof q.correct==='boolean').length} / ${attempt.questions.length} 已批改`:'答案自动保存在当前设备'}</small><button class="button" data-action="${submitted?'finish-attempt':'submit-attempt'}">${submitted?'保存成绩与复盘':'提交本次答案'} <span>→</span></button></footer>`;
}
const CAUSES = {
  reading:['词汇不认识','句子没读懂','定位错误','同义替换没识别','题型规则混淆','字数或拼写错误','时间不足','待分析'],
  listening:['没有听出词音','跟丢定位','同义替换没识别','干扰项或改口','拼写或单复数','读题来不及','时间不足','待分析'],
};
function renderGrade(q,i) {
  const subject = currentFocusedAttempt()?.subject || 'reading';
  return `<div class="grade-item"><div class="grade-head"><div class="grade-answer"><small>${esc(q.label)}</small><br><span lang="en">${esc(q.answer || '（未作答）')}</span></div><div class="grade-choices"><button class="grade-choice good ${q.correct===true?'selected':''}" data-action="grade" data-index="${i}" data-correct="true">✓ 正确</button><button class="grade-choice bad ${q.correct===false?'selected':''}" data-action="grade" data-index="${i}" data-correct="false">× 错误</button></div></div>${q.correct===false?`<div class="grade-detail"><label>失分原因<select data-cause="${i}"><option value="">选择原因</option>${CAUSES[subject].map(c=>`<option ${q.cause===c?'selected':''}>${esc(c)}</option>`).join('')}</select></label><label>正确答案与依据<textarea data-evidence="${i}" placeholder="对照教材，记录正确答案、原文句子或音频关键词。">${esc(q.evidence || '')}</textarea></label></div>`:''}</div>`;
}
function renderResult(task,a) {
  const correct = a.score?.correct ?? a.correctCount ?? a.questions.filter(q=>q.correct).length;
  const total = a.questions.length, wrong = total-correct;
  return `<div class="lesson-body"><div class="subject-label">${subjectName(a.subject)} · 本组已完成</div><h2>做完，也弄懂一点。</h2><div class="result-score">${correct}<small> / ${total}</small></div><p class="lead">${a.redo?'重做成绩':Number.isFinite(a.score?.raw40)?'全新完整卷 · 首次成绩':'专项 / 已见内容练习'} · 用时 ${fmtTime(a.elapsedSeconds)}</p><div class="result-note">${wrong?`${wrong}道错题已加入复习，安排在次日、3天后和7天后回忆。`:'这组全部正确。下次继续用原文或音频证据验证自己的判断。'}${total<40?'<br>专项成绩用于观察题型进步，不换算雅思分数。':''}${total===40?'<br>训练争取稳定30/40。正式分数依试卷换算，不作提分保证。':''}</div>${a.reviewScheduleNote?`<p class="lead">${esc(a.reviewScheduleNote)}</p>`:''}${a.note?`<div class="section-caption">这次记住的事</div><p class="lead">${esc(a.note)}</p>`:''}<details class="details-block"><summary>回看本组答案与依据</summary>${a.questions.map(q=>`<div class="review-answer"><b>${esc(q.label)} · ${q.correct?'✓':'×'}</b><br><span lang="en">${esc(q.answer || '未作答')}</span>${!q.correct?`<br>${esc(q.cause || '待分析')}<br>${esc(q.evidence || '还没有记录依据，可在错题复习中补充。')}`:''}</div>`).join('')}</details></div><footer class="lesson-footer"><a class="text-button" href="#records">查看学习记录 ↗</a><div class="button-row" style="margin:0"><button class="button secondary small" data-action="redo-attempt" data-id="${esc(a.id)}">重做这一组</button><button class="button" data-action="next">继续下一项 →</button></div></footer>`;
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
    const checklist = task.type==='reading' ? ['找到错题对应的原文依据，分清定位、理解和规则问题。','精读2–3个关键段落，拆解影响答案的长句。','整理至少3组题干与原文的同义替换，合上书再解释一次。'] : ['挑3–5个困难片段，每段10–20秒，盲听最多3次再看文本。','理解文本后跟读，并听写2–3个关键句。','合上文本原速重听，区分没听出、跟丢、干扰项和拼写问题。'];
    content = `${source?`<div class="result-note">复盘第${task.sourceDay}天的${subjectName(task.type)}：${source.score?.correct ?? source.correctCount ?? 0} / ${source.questions.length}。先从失分最多的地方开始。</div>`:'<div class="banner warn">还没有找到对应的练习成绩。请使用当天实际做过的试卷，按下面步骤复盘并留下记录。</div>'}<div class="checklist">${checklist.map((s,i)=>`<label><input type="checkbox" data-check="${i}" ${note.checks?.[i]?'checked':''}><span>${s}</span></label>`).join('')}</div>${wrong.length?`<details class="details-block"><summary>回看 ${wrong.length} 道错题</summary>${wrong.map(q=>`<div class="review-answer"><b>${esc(q.label)} · ${esc(q.cause || '待分析')}</b><br>${esc(q.evidence || '暂未记录依据，请回到原文或音频寻找。')}</div>`).join('')}</details>`:''}<div class="subheading">复盘笔记</div><label>具体依据、同义替换或听辨发现<textarea data-task-note="${task.id}" placeholder="把发现写成下一次可执行的动作。">${esc(note.text || '')}</textarea></label>`;
  } else if (task.kind==='review') {
    content = `<div class="banner">当前没有足够的${subjectName(task.type)}错题需要重做。只复习已有内容，剩余时间回看同义替换，不凑题量。</div><a class="button secondary" href="#reviews">打开错题本</a><label style="margin-top:20px">这次复习发现<textarea data-task-note="${task.id}">${esc(note.text || '')}</textarea></label>`;
  } else {
    content = `<div class="banner">今天轻量复习，不再靠大量刷题获得安全感。用真实模考成绩判断自己的节奏。</div><div class="checklist">${(task.type==='reading'?['回看常错的题型规则、字数和拼写。','确定做题顺序；阅读60分钟包含填答，没有额外转写时间。','回忆最常见的同义替换，检查机考键入习惯。']:['回看数字、日期、单复数及常错拼写。','记住原速播放一次，跟丢一题就准备下一题。','确认机考末尾核对规则；复习常见改口和干扰信号。']).map((s,i)=>`<label><input type="checkbox" data-check="${i}" ${note.checks?.[i]?'checked':''}><span>${s}</span></label>`).join('')}</div><label>带进考场的一句提醒<textarea data-task-note="${task.id}">${esc(note.text || '')}</textarea></label>`;
  }
  const adapt = getAdaptation(state,task);
  return `<div class="lesson-body"><div class="subject-label">${subjectName(task.type)} · ${kindName(task.kind)}</div><h2>${esc(task.title)}</h2>${adapt?`<div class="banner warn">先安排${adapt.minutes}分钟补强：${esc(adapt.action)}。${esc(adapt.reason)}</div>`:''}<div style="margin-top:20px">${content}</div></div><footer class="lesson-footer"><small>认真留下记录，再翻到下一项。</small><button class="button" data-action="complete-general" data-task="${task.id}">完成这一项 →</button></footer>`;
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
  return `${head('把错过的，再做明白。','先遮住依据，回忆为什么选；再翻回教材验证。','RECALL · VERIFY · REMEMBER',false)}<div class="method-tabs"><button class="filter-button ${runtime.reviewFilter==='due'?'active':''}" data-action="review-filter" data-filter="due">到期复习 ${due.length}</button><button class="filter-button ${runtime.reviewFilter==='all'?'active':''}" data-action="review-filter" data-filter="all">全部错题 ${all.length}</button></div>${list.length?list.map(r=>`<article class="paper review-card"><div class="review-card-head"><div><span class="pill ${r.subject==='reading'?'':'neutral'}">${subjectName(r.subject)}</span><strong style="margin-left:9px">${esc(r.label)}</strong></div><span class="pill ${r.completed?'green':'neutral'}">${r.completed?'已完成三轮':`第${(r.stage||0)+1}轮 · ${esc(r.dueDate)}`}</span></div><p>失分原因：${esc(r.cause || '待分析')} · 累计出错 ${r.failures || 1} 次</p><details><summary>我已回忆，展开原答案与依据</summary><div class="review-answer"><b>当时作答：</b><span lang="en">${esc(r.answer || '未作答')}</span><br><b>教材答案 / 依据：</b>${esc(r.evidence || '尚未记录，请回到对应题目补充。')}</div></details><label style="margin-top:12px">补充正确答案和依据<input data-review-evidence="${esc(r.id)}" value="${esc(r.evidence || '')}" placeholder="记录教材答案及原文 / 音频关键词"></label>${!r.completed?`<div class="button-row"><button class="button small" data-action="review-pass" data-id="${esc(r.id)}" ${r.dueDate>dateKey()?'disabled title="未到复习日，可先回看依据"':''}>${r.dueDate>dateKey()?'未到复习日，先回看':'回忆正确，安排下一轮'}</button><button class="button secondary small" data-action="review-fail" data-id="${esc(r.id)}">仍不熟，明天再来</button></div>`:''}</article>`).join(''):`<div class="paper empty-state"><span>↺</span><h2>${all.length?'今天的到期错题已复习完':'错题本，从一次认真批改开始'}</h2><p>${all.length?'按1、3、7天的间隔回忆。现在可以继续今日训练。':'完成一组真题，标出对错并记录依据，错题就会出现在这里。'}</p><a class="button" href="#today">继续今日训练 →</a></div>`}`;
}
function renderRecords() {
  const attempts = state.attempts.filter(a=>a.completedAt).slice().reverse();
  const full = attempts.filter(a=>Number.isFinite(a.score?.raw40)).slice().reverse();
  const done = Object.keys(state.completed).length;
  const latest = subject=>attempts.find(a=>a.subject===subject&&Number.isFinite(a.score?.raw40));
  const rawScore = a=>a ? `${a.score?.correct ?? a.correctCount ?? 0}/40` : '—';
  return `${head('用真实记录，看见进步。','首次与重做分开，专项与完整卷分开。没有练习数据时不生成示例成绩。','YOUR LEARNING RECORD',false)}<div class="metrics"><div class="metric"><small>阅读 · 最近全新完整卷</small><strong>${rawScore(latest('reading'))}</strong><span>训练目标稳定30/40</span></div><div class="metric"><small>听力 · 最近全新完整卷</small><strong>${rawScore(latest('listening'))}</strong><span>训练目标稳定30/40</span></div><div class="metric"><small>已完成训练</small><strong>${done}<span style="font-size:15px;color:#97a4b8"> / 120</span></strong><span>${DAYS.filter(d=>dayDone(d.day)).length}个训练日已完成</span></div><div class="metric"><small>个人词汇积累</small><strong>${state.vocabulary.length}</strong><span>来自自己的真题与同义替换</span></div></div>${full.length?`<section class="paper chart-panel"><div class="side-title"><h3>全新完整卷 · 首次正确题数</h3><small>满分40 · 深蓝阅读 / 浅蓝听力</small></div><div class="score-chart">${full.map(a=>{const correct=a.score?.correct??a.correctCount??0;return `<div class="score-column ${a.subject}"><strong>${correct}</strong><div class="bar" style="height:${correct/40*125}px"></div><small>D${a.day} · ${subjectName(a.subject)}</small></div>`;}).join('')}</div></section>`:''}<div class="button-row" style="margin:0 0 20px"><button class="button secondary small" data-action="export">导出学习备份</button><button class="button secondary small" data-action="import">导入备份</button><button class="text-button" data-action="settings">日期与已做试卷</button></div>${attempts.length?`<section class="paper records-table-wrap"><table class="records-table"><thead><tr><th>训练</th><th>科目</th><th>成绩</th><th>记录类型</th><th>用时</th><th>查看</th></tr></thead><tbody>${attempts.map(a=>`<tr><td>第${a.day}天 · ${esc(a.title || kindName(a.kind))}</td><td>${subjectName(a.subject)}</td><td><strong>${a.score?.correct??a.correctCount??0} / ${a.questions.length}</strong></td><td><span class="pill ${Number.isFinite(a.score?.raw40)?'green':'neutral'}">${a.redo?'重做':a.questions.length===40?(a.fresh?'全新完整卷':'已见完整卷'):'专项练习'}</span></td><td>${fmtTime(a.elapsedSeconds)}</td><td><button class="text-button" data-action="view-attempt" data-id="${esc(a.id)}">回看 ↗</button></td></tr>`).join('')}</tbody></table></section>`:`<div class="paper empty-state"><span>▥</span><h2>第一份成绩，来自第一组练习</h2><p>完成作答和教材批改后，网站会记录结果。专项成绩只反映这组练习，不直接估算雅思分数。</p><a class="button" href="#today">开始今日训练 →</a></div>`}<div class="banner" style="margin-top:22px">3.5是起点自评，6.5是冲刺目标。正式分数取决于实际考试；请结合完整新卷表现判断准备程度。</div>`;
}

function currentFocusedAttempt() {
  if (runtime.focusAttempt) return state.attempts.find(a=>a.id===runtime.focusAttempt);
  const task = getCurrentTask(state); return task ? activeAttempt(task) : null;
}
function currentResolvedTask() {
  const a = currentFocusedAttempt();
  if (a) return tasksForDay(state,a.day).find(t=>t.id===a.taskId);
  return getCurrentTask(state);
}
function pauseTimer() {
  if (!runtime.timer) return;
  const a = currentFocusedAttempt();
  if (a && !a.submittedAt) a.elapsedSeconds = Math.round(runtime.timerBase + (Date.now()-runtime.timerStart)/1000);
  clearInterval(runtime.timer); runtime.timer = null; writeLocal(); updateTimerDom();
}
function startTimer() {
  const a = currentFocusedAttempt(); if (!a || a.submittedAt) return;
  if (runtime.timer) return;
  runtime.timerBase = Number(a.elapsedSeconds || 0); runtime.timerStart = Date.now();
  runtime.timer = setInterval(timerTick, 1000); updateTimerDom();
}
function remainingSeconds(a) {
  const deadline = a.checkDeadline || (a.subject==='reading'&&a.questions.length===40 ? a.deadline : null);
  return deadline ? Math.max(0, Math.ceil((new Date(deadline).getTime()-Date.now())/1000)) : null;
}
function timerTick() {
  const a = currentFocusedAttempt();
  if (!a || a.submittedAt) { pauseTimer(); return; }
  a.elapsedSeconds = Math.round(runtime.timerBase+(Date.now()-runtime.timerStart)/1000);
  if (a.elapsedSeconds%5===0) writeLocal();
  if (remainingSeconds(a)===0) {
    pauseTimer(); submitAttempt(state,a.id); persist(); render(); toast('计时结束，首次答案已保存。请对照教材批改。'); return;
  }
  updateTimerDom();
}
function lockIfExpired(a) {
  if(!a || a.submittedAt || remainingSeconds(a)!==0) return false;
  pauseTimer();
  if(a.subject==='reading' && a.questions.length===40) a.elapsedSeconds=Math.max(3600,a.elapsedSeconds || 0);
  submitAttempt(state,a.id);persist();render();toast('考试时间已结束，截止前的答案已锁定。');return true;
}
function updateTimerDom() {
  const a = currentFocusedAttempt(); if (!a || a.submittedAt) return;
  const el = $('#timerValue'); if (el) el.textContent = fmtTime(remainingSeconds(a) ?? a.elapsedSeconds);
  const caption = $('#timerCaption'); if (caption) caption.textContent = remainingSeconds(a)!==null ? '按真实考试时间继续倒计时' : runtime.timer?'正在计时':'已暂停，可继续';
  const toggle = $('[data-action="timer-toggle"]'); if (toggle) toggle.textContent = runtime.timer?'暂停':'继续';
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
  openModal(`<div class="overline">DAY ${String(day).padStart(2,'0')} / 30</div><h2>${esc(d.title)}</h2><p>${esc(phaseFor(day)?.title || '')} · ${dayDone(day)?'已完成':day===current?'当前训练日':'路线预览'}</p>${['reading','listening'].map(subject=>{const t={...d[subject],type:subject};return `<div class="subheading">${subjectName(subject)} · ${esc(t.title)}</div><div class="resource-list">${resourcesHtml(t)}</div>${!t.resources.length?`<p class="lead">${t.kind==='analysis'?`复盘第${t.sourceDay}天实际做过的试卷。`:'回看错题与已经记录的方法。'}</p>`:''}`;}).join('')}<div class="banner">另有20分钟错题回忆、30分钟真题词汇、10分钟小结。${day<=3?'前3天听读各75分钟。':'听读各90分钟。'}</div><div class="button-row"><button class="button" data-action="return-today">${day===current?'继续今天的训练':'返回当前任务'} →</button></div>`);
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
    if(action==='start') {
      const t=getCurrentTask(state);if(!t||t.id!==el.dataset.task)return;
      const a=startAttempt(state,resolveTask(state,t));runtime.focusAttempt=a.id;persist();render();startTimer();
    } else if(action==='timer-toggle'){
      const a=currentFocusedAttempt();
      if(a&&['diagnostic','mock'].includes(a.kind)){toast('完整诊断与模考按考试条件计时，暂停按钮不能延长作答时间。');if(!runtime.timer)startTimer();return;}
      runtime.timer?pauseTimer():startTimer();persist();
    }
    else if(action==='submit-attempt'){
      const a=currentFocusedAttempt();if(!a)return;
      if(lockIfExpired(a))return;
      const blanks=a.questions.filter(q=>!q.answer.trim()).length;
      if(blanks&&!el.dataset.confirmed){openModal(`<h2>还有${blanks}题没有填写</h2><p>可以保留空白，提交后会锁定本次答案，再对照教材批改。</p><div class="button-row"><button class="button" data-action="submit-with-blanks">保留空白并提交</button><button class="button secondary" data-action="close-modal">继续作答</button></div>`);return;}
      pauseTimer();submitAttempt(state,a.id);persist();render();
    } else if(action==='submit-with-blanks'){
      const a=currentFocusedAttempt();closeModal();if(lockIfExpired(a))return;pauseTimer();submitAttempt(state,a.id);persist();render();
    } else if(action==='grade'){
      const a=currentFocusedAttempt();if(!a?.submittedAt||a.completedAt)return;
      a.questions[Number(el.dataset.index)].correct=el.dataset.correct==='true';persist();render();
    } else if(action==='finish-attempt'){
      const a=currentFocusedAttempt();if(!a)return;
      if(a.questions.some(q=>typeof q.correct!=='boolean')){toast('请先对照教材，逐题标记正确或错误。');return;}
      if(!a.reviewChecked){toast('请先回看错题依据，再勾选已批改与复盘。');$('#reviewChecked')?.focus();return;}
      if(['diagnostic','mock'].includes(a.kind)&&a.normalConditions!==true){a.normalConditions=false;a.fresh=false;a.conditionNote='未确认按考试条件完成，不纳入全新完整卷成绩。';}
      finishAttempt(state,a.id);runtime.focusAttempt=a.id;persist();render();window.scrollTo({top:0,behavior:'smooth'});
    } else if(action==='next'){runtime.focusAttempt=null;render();window.scrollTo({top:0,behavior:'smooth'});}
    else if(action==='listening-check'){
      const a=currentFocusedAttempt();if(!a||a.subject!=='listening')return;
      a.checkDeadline=new Date(Date.now()+120000).toISOString();persist();render();startTimer();
    } else if(action==='complete-general'){
      const t=getCurrentTask(state);if(!t||t.id!==el.dataset.task)return;
      if(t.type==='reflection') {
        const n=state.reflections[t.day];if(!n?.learned?.trim()||!n?.next?.trim()){toast('请写下一个收获和下一次要改的动作。');return;}
      } else if(t.type==='vocabulary'&&!state.vocabulary.some(w=>w.day===t.day)){toast('先从今天的真题中记录至少一个词或同义替换。');return;}
      else if(['analysis','wrapup'].includes(t.kind)){
        const n=state.taskNotes[t.id];if(!n?.checks?.every(Boolean)||n.checks.length<3||!n.text?.trim()){toast('请完成三项回顾，并留下具体复盘笔记。');return;}
      }
      completeTask(state,t.id);persist();render();window.scrollTo({top:0,behavior:'smooth'});toast('已完成，继续下一项。');
    } else if(action==='method-filter'){runtime.methodFilter=el.dataset.filter;render();}
    else if(action==='review-filter'){runtime.reviewFilter=el.dataset.filter;render();}
    else if(action==='review-pass'||action==='review-fail'){
      const r=state.reviews.find(r=>r.id===el.dataset.id);
      if(action==='review-pass'&&!r?.evidence?.trim()){toast('请先补充教材答案与依据，再确认回忆正确。');return;}
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
      pauseTimer();state=runtime.pendingImport;runtime.pendingImport=null;runtime.focusAttempt=null;persist();closeModal();render();toast('学习记录已导入。');
    } else if(action==='logout'){pauseTimer();await cloud.signOut();closeModal();render();}
    else if(action==='pull'){await cloud.pull();closeModal();toast('已检查云端记录。');}
    else if(action==='conflict-local'||action==='conflict-remote'){
      const choice=action==='conflict-local'?'local':'remote';await cloud.resolveConflict(choice);runtime.conflict=null;closeModal();render();
    } else if(action==='view-attempt'){
      pauseTimer();runtime.focusAttempt=el.dataset.id;location.hash='today';render();window.scrollTo({top:0,behavior:'smooth'});
    } else if(action==='redo-attempt'){
      const old=state.attempts.find(a=>a.id===el.dataset.id);if(!old?.completedAt)return;
      pauseTimer();const task=tasksForDay(state,old.day).find(t=>t.id===old.taskId);const a=startAttempt(state,task);runtime.focusAttempt=a.id;location.hash='today';persist();render();startTimer();
    } else if(action==='delete-word'){
      state.vocabulary=state.vocabulary.filter(w=>w.id!==el.dataset.id);persist();render();
    }
  } catch(err){toast(err.message || '操作暂未完成，记录已保留。');console.error(err);}
});

document.addEventListener('input', e=>{
  const el=e.target,a=currentFocusedAttempt(),t=getCurrentTask(state);
  if(el.dataset.answer!==undefined&&lockIfExpired(a))return;
  if(el.dataset.answer!==undefined&&a&&!a.submittedAt)a.questions[Number(el.dataset.answer)].answer=el.value;
  else if(el.dataset.evidence!==undefined&&a)a.questions[Number(el.dataset.evidence)].evidence=el.value;
  else if(el.dataset.attemptNote&&a)a.note=el.value;
  else if(el.dataset.taskNote){state.taskNotes[el.dataset.taskNote]??={checks:[false,false,false],text:''};state.taskNotes[el.dataset.taskNote].text=el.value;}
  else if(el.dataset.reflection&&t){state.reflections[t.day]??={learned:'',next:''};state.reflections[t.day][el.dataset.reflection]=el.value;}
  else if(el.dataset.reviewEvidence){const r=state.reviews.find(r=>r.id===el.dataset.reviewEvidence);if(r)r.evidence=el.value;}
  else return;
  saveSoon();
});
document.addEventListener('change',e=>{
  const el=e.target,a=currentFocusedAttempt(),t=getCurrentTask(state);
  if(el.dataset.cause!==undefined&&a)a.questions[Number(el.dataset.cause)].cause=el.value;
  else if(el.id==='reviewChecked'&&a)a.reviewChecked=el.checked;
  else if(el.id==='normalConditions'&&a)a.normalConditions=el.checked;
  else if(el.dataset.check!==undefined&&t){state.taskNotes[t.id]??={checks:[false,false,false],text:''};state.taskNotes[t.id].checks[Number(el.dataset.check)]=el.checked;}
  else return;
  persist();
});
document.addEventListener('submit',async e=>{
  if(e.target.id==='vocabForm'){
    e.preventDefault();const t=getCurrentTask(state);if(!t||t.type!=='vocabulary')return;
    const data=new FormData(e.target);if(state.vocabulary.filter(w=>w.day===t.day).length>=20){toast('每天最多新增20个词，先把已有的记住。');return;}
    const word=String(data.get('word')).trim(),meaning=String(data.get('meaning')).trim();if(!word||!meaning)return;
    state.vocabulary.push({id:crypto.randomUUID(),day:t.day,word,meaning,example:String(data.get('example')).trim(),createdAt:new Date().toISOString()});persist();render();toast('已记下，记得回到原句里复习。');
  } else if(e.target.id==='authForm'){
    e.preventDefault();const data=new FormData(e.target),button=$('button[type=submit]',e.target),msg=$('#authMessage');button.disabled=true;msg.textContent='正在连接…';
    try {
      const result=runtime.authMode==='signup'?await cloud.signUp(String(data.get('email')).trim(),String(data.get('password'))):await cloud.signIn(String(data.get('email')).trim(),String(data.get('password')));
      if(result?.confirmationRequired){msg.textContent='已发送确认邮件，请确认邮箱后回来登录。';return;}
      if(!runtime.user){msg.textContent='请确认邮箱或账号信息后重新登录。';return;}
      if(result?.state&&!result.conflict){state=normalizeState(result.state);writeLocal();}
      else if(!result?.state)await cloud.save(clone(state));
      closeModal();render();toast('已登录，学习记录按账号保存。');
    }catch(err){if(msg.isConnected)msg.textContent=err.message || '连接失败，请检查网络。';}
    finally{button.disabled=false;}
  }
});
$('#importFile').addEventListener('change',e=>importBackup(e.target.files[0]));
window.addEventListener('hashchange',()=>{render();window.scrollTo({top:0});});
window.addEventListener('pagehide',()=>{pauseTimer();clearTimeout(runtime.saveTimer);persist();});
window.addEventListener('online',()=>{if(runtime.user)cloud.pull().catch(()=>{});});
$('#modal').addEventListener('click',e=>{if(e.target===$('#modal'))closeModal();});
render();
cloud.init().then(result=>{if(result?.user&&result.state&&!result.conflict){state=normalizeState(result.state);writeLocal();render();}else if(result?.user&&!result.state)cloud.save(clone(state));}).catch(e=>setSync('error',e.message));
if('serviceWorker' in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./service-worker.js',{scope:'./'}).catch(()=>{});
