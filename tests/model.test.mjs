import test from 'node:test';
import assert from 'node:assert/strict';
import { DAYS, LISTENING_BLOCKS } from '../curriculum.js';
import {
  createState, normalizeState, dateKey, calendarInfo, tasksForDay, getCurrentTask, getSelectedTask, selectTask,
  getClaimedTasks, subjectProgress, nextSubjectTask, claimTask,
  questionsFor, resolveTask, setExposure, startAttempt, beginSelfCheck, setExternalDuration, submitAttempt, finishAttempt,
  completeTask, dueReviews, recordReview, getAdaptation, getStats, isFreshFullAttempt,
} from '../model.js';

function task(subject = 'reading', day = 1, { book = 19, test = 1, from = 1, to = 40, kind = 'diagnostic' } = {}) {
  return { id: `d${day}-${subject}`, day, type: subject, kind, resources: [{ book, test, unit: null, from, to }] };
}

function finish(state, selected, correct = 30) {
  const attempt = startAttempt(state, selected);
  attempt.questions.forEach((question, index) => {
    question.correct = index < correct;
    if (!question.correct) { question.cause = '同义替换'; question.evidence = '原文定位句'; }
  });
  attempt.normalConditions ??= true;
  submitAttempt(state, attempt.id);
  return finishAttempt(state, attempt.id);
}

test('听读各30组任务，移除词汇及小结硬任务，听力尊重课程时长且阅读维持阶段预算', () => {
  const state = createState();
  assert.equal(DAYS.length, 30);
  const ids = new Set();
  for (let day = 1; day <= 30; day++) {
    const tasks = tasksForDay(state, day);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].minutes, day <= 3 ? 75 : 90);
    assert.equal(tasks[1].minutes, DAYS[day - 1].listening.minutes);
    assert.equal(tasks.reduce((sum, item) => sum + item.minutes, 0), (day <= 3 ? 75 : 90) + DAYS[day - 1].listening.minutes);
    for (const item of tasks) {
      assert.ok(!ids.has(item.id));
      ids.add(item.id);
      assert.equal(item.day, day);
      for (const resource of item.resources) {
        assert.ok(resource.book >= 15 && resource.book <= 20);
        assert.ok(resource.test >= 1 && resource.test <= 4);
        assert.ok(resource.from >= 1 && resource.to <= 40 && resource.from <= resource.to);
      }
    }
  }
  assert.equal(ids.size, 60);
  assert.deepEqual(tasksForDay(state, 31), []);
  assert.equal(getStats(state).totalTasks, 60);
});

test('填空题号与多资源题号保持准确，分析任务不生成重复试题', () => {
  const state = createState();
  const first = tasksForDay(state, 1)[0];
  assert.equal(first.resources[0].book, 17);
  assert.deepEqual(questionsFor(first).map(item => item.number), [1, 2, 3, 4, 5, 6]);
  assert.match(questionsFor(first)[0].label, /剑17.*T1.*Q1/);
  assert.equal(questionsFor(tasksForDay(state, 7)[0]).length, 20);
  const duplicate = task();
  duplicate.resources.push(...duplicate.resources);
  assert.equal(questionsFor(duplicate).length, 40);
  assert.deepEqual(questionsFor({ ...task(), kind: 'analysis' }), []);
  assert.deepEqual(questionsFor(tasksForDay(state, 6)[1]), []);
});

test('进度跟随首个未完成任务，30天截止日期按日历计算', () => {
  const state = createState();
  state.profile.startDate = '2026-10-19';
  assert.equal(getCurrentTask(state).id, 'd1-reading');
  completeTask(state, 'd1-reading');
  assert.equal(getCurrentTask(state).id, 'd1-listening');
  completeTask(state, 'd1-listening');
  completeTask(state, 'd1-vocabulary');
  completeTask(state, 'd1-reflection');
  assert.equal(getCurrentTask(state).id, 'd2-reading');
  assert.deepEqual(calendarInfo(state, '2026-10-19'), { elapsedDay: 1, remaining: 30, deadline: '2026-11-17', completedDays: 1 });
  assert.equal(calendarInfo(state, '2026-11-18').remaining, 0);
  assert.equal(calendarInfo(state, '2026-10-18').elapsedDay, 0);
  assert.throws(() => completeTask(state, 'd99-reading'), /无效/);
});

test('阅读污染不会影响听力，替换按19T3、19T4顺序且稳定预留', () => {
  const state = createState();
  setExposure(state, 'reading', 19, 1, true);
  const resolved = resolveTask(state, task());
  assert.equal(resolved.resources[0].book, 19);
  assert.equal(resolved.resources[0].test, 3);
  assert.equal(resolved.fresh, true);
  assert.match(resolved.replacement, /已见/);
  assert.equal(resolveTask(state, task()).resources[0].test, 3);
  const hearing = resolveTask(state, task('listening'));
  assert.equal(hearing.resources[0].test, 1);
  setExposure(state, 'reading', 18, 1, true);
  const next = resolveTask(state, task('reading', 22, { book: 18, test: 1, kind: 'mock' }));
  assert.equal(next.resources[0].test, 4);
});

test('全部备用卷已见时明确复测，手动取消标记也不会洗白真实练习', () => {
  const state = createState();
  for (const [book, paper] of [[19, 1], [19, 3], [19, 4], [20, 1], [20, 2], [20, 3], [20, 4]]) setExposure(state, 'reading', book, paper, true);
  const repeated = resolveTask(state, task());
  assert.equal(repeated.fresh, false);
  assert.match(repeated.replacement, /复测/);
  const clean = createState();
  finish(clean, task('reading', 3, { book: 19, test: 1, to: 6, kind: 'practice' }), 5);
  setExposure(clean, 'reading', 19, 1, false);
  assert.equal(resolveTask(clean, task('reading', 2)).resources[0].test, 3);
});

test('未提交不能完成；自评必须逐题完成；首次答案独立锁定', () => {
  const state = createState();
  const selected = task('reading', 1, { book: 17, test: 1, to: 6, kind: 'practice' });
  const attempt = startAttempt(state, selected, { recordingMode: 'answer-entry' });
  assert.equal(startAttempt(state, selected), attempt);
  attempt.questions[0].answer = 'original';
  assert.throws(() => finishAttempt(state, attempt.id), /先提交/);
  submitAttempt(state, attempt.id);
  attempt.questions[0].answer = 'changed';
  assert.equal(attempt.originalAnswers[0].answer, 'original');
  assert.throws(() => finishAttempt(state, attempt.id), /逐题/);
  attempt.questions.forEach((question, index) => question.correct = index !== 0);
  finishAttempt(state, attempt.id);
  assert.equal(attempt.questions[0].answer, 'original');
  assert.equal(attempt.score.correct, 5);
  assert.equal(attempt.score.total, 6);
  assert.equal(attempt.score.raw40, null);
  assert.equal(state.reviews.length, 1);
  assert.equal(state.reviews[0].cause, '待分析');
  assert.ok(state.completed[selected.id]);
  assert.equal(state.drafts[selected.id], undefined);
  finishAttempt(state, attempt.id);
  assert.equal(state.reviews.length, 1);
});

test('首次新卷40题与重做分开统计，专项不能估算分数', () => {
  const state = createState();
  const selected = task();
  const first = finish(state, selected, 25);
  assert.equal(first.deadline, undefined);
  assert.equal(first.score.raw40, 25);
  const repeated = finish(state, selected, 35);
  assert.equal(repeated.redo, true);
  assert.equal(repeated.fresh, false);
  assert.equal(repeated.score.raw40, null);
  finish(state, task('reading', 3, { book: 17, test: 1, from: 1, to: 40, kind: 'practice' }), 20);
  finish(state, task('listening', 3, { book: 17, test: 2, from: 1, to: 39, kind: 'diagnostic' }), 30);
  const stats = getStats(state);
  assert.equal(stats.reading.raw40.length, 1);
  assert.equal(stats.reading.latest40.correct, 25);
  assert.equal(stats.reading.retest40[0].correct, 35);
  assert.equal(stats.reading.practiceAccuracy, 50);
  assert.equal(stats.listening.raw40.length, 0);
  assert.equal(stats.reading.targetGap, 5);
  assert.equal('band' in stats.reading, false);
});

test('错题按次日、第3日、第7日复习；未通过次日再来', () => {
  const state = createState();
  state.reviews = [{ id: 'r1', subject: 'reading', createdAt: '2026-10-19T08:00:00Z', dueDate: '2026-10-20', stage: 0, failures: 1, completed: false }];
  assert.equal(dueReviews(state, '2026-10-19').length, 0);
  assert.equal(dueReviews(state, '2026-10-20').length, 1);
  const review = recordReview(state, 'r1', true, new Date('2026-10-20T08:00:00'));
  assert.equal(review.dueDate, '2026-10-22');
  recordReview(state, 'r1', false, new Date('2026-10-22T08:00:00'));
  assert.equal(review.stage, 1);
  assert.equal(review.dueDate, '2026-10-23');
  assert.equal(review.failures, 2);
  recordReview(state, 'r1', true, new Date('2026-10-23T08:00:00'));
  assert.equal(review.dueDate, '2026-10-26');
  recordReview(state, 'r1', true, new Date('2026-10-26T08:00:00'));
  assert.equal(review.completed, true);
  assert.equal(dueReviews(state, '2026-10-30').length, 0);
  assert.equal(review.history.length, 4);
});

test('阅读24组按到期日和错误次数选8题，听力错题仍保留到期队列', () => {
  const state = createState();
  for (const subject of ['reading', 'listening']) for (let number = 1; number <= 12; number++) {
    state.reviews.push({ id: `${subject}-${number}`, questionId: `q-${subject}-${number}`, subject, book: 17, test: 1, unit: 1,
      number, label: `Q${number}`, dueDate: '2020-01-01', createdAt: '2020-01-01T08:00:00Z', failures: number, stage: 0, completed: false });
  }
  const reading = tasksForDay(state, 24)[0];
  assert.equal(reading.reviewItems.length, 8);
  assert.equal(dueReviews(state).filter(review => review.subject === 'listening').length, 12);
  assert.equal(reading.reviewItems[0].number, 12);
  assert.equal(reading.resources[0].book, 17);
  assert.equal(reading.resources[0].from, 5);
  assert.equal(reading.resources[0].to, 12);
  assert.equal(questionsFor(reading)[0].reviewId, 'reading-12');
  const attempt = finish(state, reading, 8);
  assert.equal(attempt.score.raw40, null);
  assert.equal(state.reviews.length, 24);
  assert.equal(state.reviews.find(review => review.id === 'reading-12').stage, 1);
});

test('第7天不足70%与第14天不足23/40触发补强且不加总时长', () => {
  const state = createState();
  finish(state, task('reading', 7, { book: 17, test: 1, to: 20, kind: 'practice' }), 13);
  finish(state, task('listening', 7, { book: 17, test: 2, to: 20, kind: 'practice' }), 14);
  assert.equal(getAdaptation(state, { type: 'reading', day: 8 }).minutes, 20);
  assert.equal(getAdaptation(state, { type: 'reading', day: 10 }).minutes, 20);
  assert.equal(getAdaptation(state, { type: 'reading', day: 11 }), null);
  assert.equal(getAdaptation(state, { type: 'listening', day: 8 }), null);
  finish(state, task('reading', 14, { book: 19, test: 2 }), 22);
  assert.equal(getAdaptation(state, { type: 'reading', day: 15 }).minutes, 30);
  assert.equal(getAdaptation(state, { type: 'reading', day: 17 }).minutes, 30);
  assert.equal(getAdaptation(state, { type: 'reading', day: 18 }), null);
  assert.equal(tasksForDay(state, 15)[0].minutes, 90);
});

test('normalize恢复计时、答案、首次快照和未知字段，不修改原记录', () => {
  const state = createState();
  state.futureCloudField = { version: 3 };
  state.profile.futurePreference = true;
  state.taskNotes['d1-reading'] = { note: '明天精读' };
  const attempt = startAttempt(state, task(), { recordingMode: 'answer-entry' });
  attempt.elapsedSeconds = 107;
  attempt.questions[0].answer = 'draft';
  submitAttempt(state, attempt.id);
  const restored = normalizeState(JSON.parse(JSON.stringify(state)));
  const active = startAttempt(restored, task());
  assert.equal(active.id, attempt.id);
  assert.equal(active.elapsedSeconds, 107);
  assert.equal(active.deadline, attempt.deadline);
  assert.equal(active.originalAnswers[0].answer, 'draft');
  assert.equal(restored.taskNotes['d1-reading'].note, '明天精读');
  assert.equal(restored.futureCloudField.version, 3);
  assert.equal(restored.profile.futurePreference, true);
  restored.attempts[0].questions[0].answer = 'different';
  assert.equal(state.attempts[0].questions[0].answer, 'draft');
  assert.deepEqual(normalizeState({ attempts: null, reviews: 'bad', drafts: [] }).attempts, []);
  assert.match(dateKey(new Date()), /^\d{4}-\d{2}-\d{2}$/);
});

test('非法导入日期与成绩回到默认值，损坏条目被过滤且合法扩展字段保留', () => {
  const state = createState();
  const attempt = startAttempt(state, task());
  state.profile.startDate = '2026-02-30';
  state.profile.baseline = 'not a number';
  state.profile.target = '8';
  attempt.questions.push(null, {}, { id: 'bad', number: -1 });
  state.attempts.push(null, {});
  state.reviews.push(null, {}, { id: 'bad', subject: 'reading', number: 5 });
  state.vocabulary = [null, {}, { word: 42, day: 1 }, { id: 'good', word: 'evidence', meaning: '依据', day: 1, customField: true }];
  state.taskNotes.bad = { checks: 'not an array', text: 42, extension: true };
  state.reflections.bad = { learned: 42, next: false, extension: true };
  state.assignments.bad = null;
  const restored = normalizeState(state);
  assert.equal(restored.profile.startDate, dateKey());
  assert.equal(restored.profile.baseline, 3.5);
  assert.equal(restored.profile.target, 8);
  assert.equal(restored.attempts.length, 1);
  assert.equal(restored.attempts[0].questions.length, 40);
  assert.equal(restored.reviews.length, 0);
  assert.equal(restored.vocabulary.length, 1);
  assert.equal(restored.vocabulary[0].customField, true);
  assert.deepEqual(restored.taskNotes.bad.checks, []);
  assert.equal(restored.taskNotes.bad.extension, true);
  assert.equal(restored.reflections.bad.learned, '42');
  assert.ok(Number.isFinite(calendarInfo(restored).remaining));
  assert.doesNotThrow(() => getStats(restored));
  const other = normalizeState({ profile: { startDate: 'not a date', baseline: Infinity, target: 10 } });
  assert.equal(other.profile.target, 6.5);
  assert.equal(other.profile.baseline, 3.5);
});

test('非正常考试条件完整40题仍保留练习记录，不能进入新卷成绩', () => {
  const state = createState();
  const selected = task();
  const attempt = startAttempt(state, selected);
  attempt.normalConditions = false;
  assert.equal(attempt.fresh, true);
  finish(state, selected, 35);
  assert.equal(attempt.score.correct, 35);
  assert.equal(attempt.score.raw40, null);
  assert.equal(getStats(state).reading.raw40.length, 0);
  assert.equal(getStats(state).reading.retest40.length, 1);
  // Even a malformed imported score cannot bypass the normal-conditions flag.
  attempt.score.raw40 = 35;
  assert.equal(getStats(state).reading.raw40.length, 0);
});

test('D24稀疏错题资源只显示实际题号范围，不暗示需要重做中间题', () => {
  const state = createState();
  state.reviews = [1, 4, 5, 9].map(number => ({ id: `r${number}`, questionId: `q${number}`, subject: 'reading', book: 17, test: 1, unit: 1,
    number, label: `Q${number}`, dueDate: '2020-01-01', createdAt: '2020-01-01T08:00:00Z', failures: 1, completed: false }));
  const reading = tasksForDay(state, 24)[0];
  assert.deepEqual(reading.resources.map(item => [item.from, item.to]), [[1, 1], [4, 5], [9, 9]]);
  assert.equal(questionsFor(reading).length, 4);
});

test('同一道错题不能在同一天连续通过三轮，未到期时失败仍可安排明日', () => {
  const state = createState();
  state.reviews = [{ id: 'r1', subject: 'reading', createdAt: '2026-10-19T08:00:00Z', dueDate: '2026-10-20', stage: 0, failures: 1, completed: false }];
  const now = new Date('2026-10-20T08:00:00');
  const review = recordReview(state, 'r1', true, now);
  assert.equal(review.stage, 1);
  assert.equal(review.dueDate, '2026-10-22');
  assert.throws(() => recordReview(state, 'r1', true, now), /未到期/);
  assert.throws(() => recordReview(state, 'r1', true, now), /未到期/);
  assert.equal(review.stage, 1);
  assert.equal(review.completed, false);
  assert.equal(review.history.length, 1);
  recordReview(state, 'r1', false, now);
  assert.equal(review.dueDate, '2026-10-21');
  assert.equal(review.stage, 1);
  assert.equal(review.failures, 2);
  assert.throws(() => recordReview(state, 'r1', true, now), /未到期/);
});

test('D24重做克隆上次题目与教材位置，不重新抽取已变化的到期队列', () => {
  const state = createState();
  state.reviews = Array.from({ length: 12 }, (_, index) => ({ id: `r${index + 1}`, questionId: `q${index + 1}`, subject: 'reading',
    book: 17, test: 1, unit: 1, number: index + 1, label: `Q${index + 1}`, dueDate: '2020-01-01',
    createdAt: '2020-01-01T08:00:00Z', failures: 1, stage: 0, completed: false }));
  const originalTask = tasksForDay(state, 24)[0];
  const first = finish(state, originalTask, 8);
  const completedAt = state.completed[first.taskId];
  const changedTask = tasksForDay(state, 24)[0];
  assert.deepEqual(questionsFor(changedTask).map(question => question.number), [1, 2, 3, 4, 5, 6, 7, 8]);
  const redo = startAttempt(state, changedTask);
  assert.equal(redo.redo, true);
  assert.equal(redo.fresh, false);
  assert.deepEqual(redo.resources, first.resources);
  assert.deepEqual(redo.questions.map(question => question.number), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(redo.questions[0].reviewId, 'r1');
  assert.equal(Object.hasOwn(redo.questions[0], 'answer'), false);
  assert.equal(redo.questions[0].correct, null);
  assert.equal(redo.questions[0].cause, '');
  assert.equal(redo.questions[0].evidence, '');
  finish(state, changedTask, 8);
  assert.equal(redo.score.correct, 8);
  assert.equal(redo.score.total, 8);
  assert.equal(redo.score.raw40, null);
  assert.equal(state.attempts.length, 2);
  assert.equal(state.completed[first.taskId], completedAt);
  assert.equal(state.reviews[0].stage, 1);
  assert.ok(redo.reviewScheduleNote);
});

test('两科分别领取，一科未完成不阻止另一科继续领取，已完成任务可以回看', () => {
  const state = createState();
  assert.equal(state.selectedTaskId, null);
  assert.equal(getSelectedTask(state), null);
  assert.deepEqual(getClaimedTasks(state), []);
  const listening = claimTask(state, 'listening');
  assert.equal(listening.id, 'd1-listening');
  assert.equal(getSelectedTask(state).id, 'd1-listening');
  assert.equal(getCurrentTask(state).id, 'd1-reading');
  finish(state, listening, 25);
  assert.equal(getCurrentTask(state).id, 'd1-reading');
  assert.equal(getSelectedTask(state).id, 'd1-listening');
  assert.ok(state.completed['d1-listening']);
  assert.equal(state.completed['d1-reading'], undefined);
  assert.equal(selectTask(state, 'd1-reading').id, 'd1-reading');
  assert.equal(selectTask(state, 'd1-listening').id, 'd1-listening');
  assert.throws(() => selectTask(state, 'd2-reading'), /先完成/);
  assert.throws(() => selectTask(state, 'd0-listening'), /有效/);
  assert.equal(claimTask(state, 'listening').id, 'd2-listening');
  assert.equal(getSelectedTask(state).day, 2);
  assert.equal(subjectProgress(state, 'reading').activeTask.id, 'd1-reading');
  assert.equal(subjectProgress(state, 'listening').activeTask.id, 'd2-listening');
  assert.equal(subjectProgress(state, 'listening').completed, 1);
  assert.equal(getClaimedTasks(state).length, 2);
  assert.equal(getClaimedTasks(state, { includeCompleted: true }).length, 3);
});

test('两科各自草稿在切换与刷新后恢复，互不覆盖答案、计时或提交状态', () => {
  let state = createState();
  const reading = startAttempt(state, selectTask(state, 'd1-reading'), { recordingMode: 'answer-entry' });
  reading.questions[0].answer = 'reading draft';
  reading.elapsedSeconds = 87;
  const listening = startAttempt(state, selectTask(state, 'd1-listening'), { recordingMode: 'answer-entry' });
  listening.questions[0].answer = 'listening draft';
  listening.elapsedSeconds = 214;
  submitAttempt(state, listening.id);
  assert.notEqual(reading.id, listening.id);
  assert.equal(state.drafts['d1-reading'], reading.id);
  assert.equal(state.drafts['d1-listening'], listening.id);
  state = normalizeState(JSON.parse(JSON.stringify(state)));
  assert.equal(state.selectedTaskId, 'd1-listening');
  assert.equal(getSelectedTask(state).id, 'd1-listening');
  const resumedListening = startAttempt(state, getSelectedTask(state));
  assert.equal(resumedListening.id, listening.id);
  assert.equal(resumedListening.originalAnswers[0].answer, 'listening draft');
  assert.equal(resumedListening.elapsedSeconds, 214);
  assert.ok(resumedListening.submittedAt);
  const resumedReading = startAttempt(state, selectTask(state, 'd1-reading'));
  assert.equal(resumedReading.id, reading.id);
  assert.equal(resumedReading.questions[0].answer, 'reading draft');
  assert.equal(resumedReading.elapsedSeconds, 87);
  assert.equal(resumedReading.submittedAt, null);
  assert.equal(getCurrentTask(state).day, 1);
});

test('完成任务后等待手动领取下一组，不自动生成作业，也不受另一科进度限制', () => {
  const state = createState();
  claimTask(state, 'listening');
  assert.equal(subjectProgress(state, 'listening').nextTask, null);
  completeTask(state, 'd1-listening');
  assert.equal(getCurrentTask(state).id, 'd1-reading');
  assert.equal(getSelectedTask(state).id, 'd1-listening');
  assert.equal(subjectProgress(state, 'listening').activeTask, null);
  assert.equal(subjectProgress(state, 'listening').nextTask.id, 'd2-listening');
  assert.equal(state.claimedTasks['d2-listening'], undefined);
  assert.equal(getClaimedTasks(state).length, 0);
  assert.equal(claimTask(state, 'listening').id, 'd2-listening');
  assert.equal(claimTask(state, 'listening').id, 'd2-listening');
  assert.throws(() => claimTask(state, 'd3-listening'), /先完成/);
  assert.equal(subjectProgress(state, 'reading').claimed, 0);
  for (let day = 2; day <= 30; day++) {
    assert.equal(claimTask(state, 'listening').day, day);
    completeTask(state, `d${day}-listening`);
  }
  assert.equal(nextSubjectTask(state, 'listening'), null);
  assert.equal(subjectProgress(state, 'listening').completed, 30);
  assert.equal(subjectProgress(state, 'reading').completed, 0);
  assert.throws(() => claimTask(state, 'listening'), /已完成/);
  assert.equal(selectTask(state, 'd1-listening').id, 'd1-listening');
  assert.equal(getStats(state).completedTasks, 30);
  assert.equal(getStats(state).totalTasks, 60);
});

test('无领取记录时显示任务大厅，非法选择安全回退，跨组领取和选择刷新保留', () => {
  const legacy = normalizeState({ profile: { startDate: '2026-10-19' } });
  assert.equal(legacy.selectedTaskId, null);
  assert.equal(getSelectedTask(legacy), null);
  for (const selectedTaskId of ['d0-reading', 'd31-reading', 'd01-reading', 'd1-other', {}, 1, null]) {
    const normalized = normalizeState({ selectedTaskId });
    assert.equal(normalized.selectedTaskId, null);
    assert.equal(getSelectedTask(normalized), null);
  }
  const valid = normalizeState({ selectedTaskId: 'd1-listening', claimedTasks: { 'd1-listening': '2026-10-19T08:00:00Z' } });
  assert.equal(getSelectedTask(valid).id, 'd1-listening');
  const future = normalizeState({ selectedTaskId: 'd2-listening' });
  assert.equal(getSelectedTask(future), null);
  assert.equal(getCurrentTask(future).day, 1);
  assert.equal(future.selectedTaskId, 'd2-listening');
  const independent = normalizeState({ selectedTaskId: 'd4-listening', completed: { 'd1-listening': '2026-10-19T08:00:00Z', 'd2-listening': '2026-10-19T08:00:00Z', 'd3-listening': '2026-10-19T08:00:00Z' },
    claimedTasks: { 'd4-listening': '2026-10-19T08:00:00Z' } });
  assert.equal(getSelectedTask(independent).id, 'd4-listening');
  assert.equal(subjectProgress(independent, 'reading').nextTask.id, 'd1-reading');
  assert.equal(subjectProgress(independent, 'listening').activeTask.id, 'd4-listening');
});

test('旧版双科答题草稿切换及刷新后，已存阅读和听力截止时间保持兼容', () => {
  let state = createState();
  for (let day = 1; day <= 13; day++) for (const task of tasksForDay(state, day)) completeTask(state, task.id);
  assert.equal(getCurrentTask(state).day, 14);
  const reading = startAttempt(state, selectTask(state, 'd14-reading'), { recordingMode: 'answer-entry' });
  assert.equal(reading.questions.length, 40);
  const readingDeadline = reading.deadline;
  assert.equal(new Date(readingDeadline) - new Date(reading.startedAt), 3600000);
  reading.elapsedSeconds = 720;
  state.selectedTaskId = 'd14-listening';
  const listening = startAttempt(state, task('listening', 14, { book: 16, test: 4, to: 20, kind: 'practice' }), { recordingMode: 'answer-entry' });
  assert.ok(listening.questions.length > 0);
  listening.elapsedSeconds = 1800;
  const listeningCheckDeadline = new Date(Date.now() + 120000).toISOString();
  listening.checkDeadline = listeningCheckDeadline;
  assert.equal(startAttempt(state, selectTask(state, 'd14-reading')).id, reading.id);
  assert.equal(startAttempt(state, selectTask(state, 'd14-listening')).id, listening.id);
  state = normalizeState(JSON.parse(JSON.stringify(state)));
  assert.equal(getSelectedTask(state).id, 'd14-listening');
  const restoredListening = startAttempt(state, getSelectedTask(state));
  const restoredReading = startAttempt(state, selectTask(state, 'd14-reading'));
  assert.equal(restoredListening.id, listening.id);
  assert.equal(restoredListening.checkDeadline, listeningCheckDeadline);
  assert.equal(restoredListening.elapsedSeconds, 1800);
  assert.equal(restoredReading.id, reading.id);
  assert.equal(restoredReading.deadline, readingDeadline);
  assert.equal(restoredReading.elapsedSeconds, 720);
  assert.equal(state.attempts.length, 2);
  assert.equal(getCurrentTask(state).day, 14);
});

test('新建练习直接逐题标对错，不产生空答案、首次答案快照或站内倒计时', () => {
  const state = createState();
  const selected = task('reading', 1, { book: 17, test: 1, to: 6, kind: 'practice' });
  const attempt = startAttempt(state, selected);
  assert.equal(attempt.recordingMode, 'self-check');
  assert.equal(attempt.submittedAt, attempt.startedAt);
  assert.equal(attempt.deadline, undefined);
  assert.equal(attempt.checkDeadline, undefined);
  assert.equal(attempt.durationProvided, false);
  assert.equal(attempt.originalAnswers, undefined);
  assert.ok(attempt.questions.every(question => !Object.hasOwn(question, 'answer')));
  assert.equal(state.exposures['reading-17-1'].seen, true);
  assert.throws(() => finishAttempt(state, attempt.id), /逐题/);
  submitAttempt(state, attempt.id);
  assert.equal(attempt.originalAnswers, undefined);
  attempt.questions.forEach((question, index) => question.correct = index !== 0);
  finishAttempt(state, attempt.id);
  assert.equal(attempt.score.correct, 5);
  assert.equal(attempt.score.total, 6);
  assert.equal(state.reviews.length, 1);
  assert.equal(Object.hasOwn(state.reviews[0], 'answer'), false);
  const restored = normalizeState(state);
  assert.equal(restored.attempts[0].recordingMode, 'self-check');
  assert.equal(Object.hasOwn(restored.attempts[0].questions[0], 'answer'), false);
  assert.equal(Object.hasOwn(restored.reviews[0], 'answer'), false);
});

test('外部做题用时可不填、填写或清除，切换刷新不会产生内部截止时间', () => {
  let state = createState();
  const reading = startAttempt(state, selectTask(state, 'd1-reading'));
  const listening = startAttempt(state, selectTask(state, 'd1-listening'));
  setExternalDuration(state, reading.id, 1200.4);
  assert.equal(reading.elapsedSeconds, 1200);
  assert.equal(reading.durationProvided, true);
  assert.equal(reading.durationSource, 'external');
  assert.equal(listening.elapsedSeconds, 0);
  assert.equal(listening.durationProvided, false);
  assert.throws(() => setExternalDuration(state, reading.id, -1), /有效/);
  assert.throws(() => setExternalDuration(state, reading.id, Infinity), /有效/);
  assert.throws(() => setExternalDuration(state, reading.id, '20'), /有效/);
  state = normalizeState(JSON.parse(JSON.stringify(state)));
  const restored = startAttempt(state, selectTask(state, 'd1-reading'));
  assert.equal(restored.id, reading.id);
  assert.equal(restored.elapsedSeconds, 1200);
  assert.equal(restored.durationProvided, true);
  assert.equal(restored.deadline, undefined);
  setExternalDuration(state, restored.id, null);
  assert.equal(restored.elapsedSeconds, 0);
  assert.equal(restored.durationProvided, false);
  setExternalDuration(state, restored.id, 0);
  assert.equal(restored.durationProvided, true);
});

test('旧答题记录可转逐题自评并保留答案快照和历史计时，完成记录不会被改写', () => {
  const state = createState();
  const selected = task('reading', 1, { to: 2, kind: 'practice' });
  const old = startAttempt(state, selected, { recordingMode: 'answer-entry' });
  old.questions[0].answer = 'real old answer';
  old.elapsedSeconds = 52;
  submitAttempt(state, old.id);
  const originalAnswers = JSON.stringify(old.originalAnswers);
  beginSelfCheck(state, old.id);
  assert.equal(old.recordingMode, 'self-check');
  assert.equal(old.questions[0].answer, 'real old answer');
  assert.equal(JSON.stringify(old.originalAnswers), originalAnswers);
  assert.equal(old.elapsedSeconds, 52);
  old.questions[0].correct = false;
  old.questions[1].correct = true;
  finishAttempt(state, old.id);
  assert.equal(state.reviews[0].answer, 'real old answer');
  const completedSnapshot = JSON.stringify(old);
  beginSelfCheck(state, old.id);
  assert.equal(JSON.stringify(old), completedSnapshot);
  const unsubmitted = startAttempt(state, task('listening', 1, { to: 2, kind: 'practice' }), { recordingMode: 'answer-entry' });
  unsubmitted.questions[0].answer = 'unsent draft';
  beginSelfCheck(state, unsubmitted.id);
  assert.ok(unsubmitted.submittedAt);
  assert.equal(unsubmitted.questions[0].answer, 'unsent draft');
  assert.equal(unsubmitted.originalAnswers, undefined);
});

test('自评完整卷必须明确确认正常考试条件，不能把未确认的记录算作新卷基准', () => {
  const unconfirmed = createState();
  const attempt = startAttempt(unconfirmed, task());
  attempt.questions.forEach(question => question.correct = true);
  finishAttempt(unconfirmed, attempt.id);
  assert.equal(attempt.fresh, true);
  assert.equal(attempt.normalConditions, undefined);
  assert.equal(attempt.score.correct, 40);
  assert.equal(attempt.score.raw40, null);
  assert.equal(getStats(unconfirmed).reading.raw40.length, 0);
  const confirmed = createState();
  const valid = startAttempt(confirmed, task());
  valid.questions.forEach(question => question.correct = true);
  valid.normalConditions = true;
  finishAttempt(confirmed, valid.id);
  assert.equal(valid.score.raw40, 40);
  assert.equal(getStats(confirmed).reading.latest40.correct, 40);
  assert.equal(valid.deadline, undefined);
});

test('第14天听力20题专项不足70%只调配20分钟，阅读仍用40题23分门槛', () => {
  const state = createState();
  finish(state, task('listening', 14, { book: 16, test: 4, to: 20, kind: 'practice' }), 13);
  const extra = getAdaptation(state, { type: 'listening', day: 15 });
  assert.equal(extra.minutes, 20);
  assert.match(extra.reason, /13\/20/);
  assert.equal(getAdaptation(state, { type: 'listening', day: 17 }).minutes, 20);
  assert.equal(getAdaptation(state, { type: 'listening', day: 18 }), null);
  assert.equal(getStats(state).listening.raw40.length, 0);
  const atThreshold = createState();
  finish(atThreshold, task('listening', 14, { book: 16, test: 4, to: 20, kind: 'practice' }), 14);
  assert.equal(getAdaptation(atThreshold, { type: 'listening', day: 15 }), null);
  finish(state, task('reading', 14, { book: 19, test: 2 }), 22);
  assert.equal(getAdaptation(state, { type: 'reading', day: 15 }).minutes, 30);
});

test('听力从完整Part 1起步，三套整卷后分别复盘，专项时间不按题数凑长', () => {
  const state = createState();
  for (let day = 1; day <= 5; day++) assert.equal(questionsFor(tasksForDay(state, day)[1]).length, 10);
  assert.equal(questionsFor(tasksForDay(state, 7)[1]).length, 5);
  assert.equal(questionsFor(tasksForDay(state, 14)[1]).length, 6);
  const full = DAYS.filter(day => ['diagnostic', 'mock'].includes(day.listening.kind));
  assert.deepEqual(full.map(day => [day.day, day.listening.resources[0].book, day.listening.resources[0].test]), [[24, 19, 2], [27, 18, 1], [29, 18, 2]]);
  for (const day of DAYS) {
    const plan = day.listening.listeningPlan;
    assert.equal(plan.firstPassMinutes + plan.reviewMinutes + plan.spellingMinutes + plan.recallMinutes, day.listening.minutes);
    assert.ok(day.listening.minutes >= 15 && day.listening.minutes <= 55);
    if (day.listening.kind === 'practice') assert.ok(day.listening.minutes <= 40);
    assert.equal(plan.newQuestions, ['analysis', 'review', 'wrapup'].includes(day.listening.kind) ? 0 : questionsFor({ ...day.listening, type: 'listening' }).length);
    assert.ok(plan.segments <= 2 && plan.segmentSeconds <= 20 && plan.dictationSentences <= 1);
    assert.equal(day.listening.curriculumVersion, 'listening-v3');
  }
  assert.equal(DAYS.reduce((total, day) => total + day.listening.listeningPlan.newQuestions, 0), 279);
  assert.equal(DAYS.reduce((total, day) => total + day.listening.minutes, 0), 880);
});

test('无模式旧草稿经normalize迁移后，已记录用时继续显示；显式未填的自评用时不被改写', () => {
  const state = normalizeState({ attempts: [{ id: 'legacy', taskId: 'd1-reading', subject: 'reading', day: 1, kind: 'practice',
    resources: [{ book: 17, test: 1, unit: 1, from: 1, to: 2 }],
    questions: [{ id: 'reading-17-1-1', book: 17, test: 1, unit: 1, number: 1, answer: 'old answer' }],
    startedAt: '2026-10-19T08:00:00Z', submittedAt: null, completedAt: null,
    elapsedSeconds: 123, durationProvided: false,
  }] });
  const old = state.attempts[0];
  assert.equal(old.recordingMode, 'answer-entry');
  beginSelfCheck(state, old.id);
  assert.equal(old.recordingMode, 'self-check');
  assert.equal(old.elapsedSeconds, 123);
  assert.equal(old.durationProvided, true);
  assert.equal(old.durationSource, 'legacy-timer');
  assert.equal(old.questions[0].answer, 'old answer');
  const fresh = startAttempt(state, task('listening', 1, { to: 5, kind: 'practice' }));
  fresh.elapsedSeconds = 99;
  fresh.durationProvided = false;
  beginSelfCheck(state, fresh.id);
  assert.equal(fresh.durationProvided, false);
  assert.equal(fresh.durationSource, 'external');
});

test('整卷复盘使用实际替补教材和题量，保留新版短精听预算', () => {
  const state = createState();
  const old = finish(state, task('listening', 24, { book: 20, test: 1 }), 18);
  const review = tasksForDay(state, 25)[1];
  assert.equal(review.kind, 'analysis');
  assert.equal(review.title, '复盘第24组听力 · 实际40题');
  assert.equal(review.analysisOf, old.id);
  assert.deepEqual(review.resources, old.resources);
  assert.equal(review.minutes, DAYS[24].listening.minutes);
  assert.deepEqual(review.listeningPlan, DAYS[24].listening.listeningPlan);
  assert.ok(review.minutes <= 25);
  assert.deepEqual(questionsFor(review), []);
});

test('旧版第14天听力40题诊断仍按23题门槛调配30分钟，不误套20题规则', () => {
  const state = createState();
  finish(state, task('listening', 14, { book: 19, test: 2 }), 22);
  const extra = getAdaptation(state, { type: 'listening', day: 15 });
  assert.equal(extra.minutes, 30);
  assert.match(extra.reason, /22\/40/);
  assert.match(extra.reason, /旧版/);
  assert.equal(getAdaptation(state, { type: 'listening', day: 17 }).minutes, 30);
  assert.equal(getAdaptation(state, { type: 'listening', day: 18 }), null);
  const threshold = createState();
  finish(threshold, task('listening', 14, { book: 19, test: 2 }), 23);
  assert.equal(getAdaptation(threshold, { type: 'listening', day: 15 }), null);
});

test('完整新卷统一判定排除专项、重复题号、重做和未确认条件', () => {
  const state = createState();
  const full = finish(state, task(), 30);
  assert.equal(isFreshFullAttempt(full), true);
  assert.equal(isFreshFullAttempt(null), false);
  assert.equal(isFreshFullAttempt({}), false);
  assert.equal(isFreshFullAttempt({ ...full, kind: 'practice' }), false);
  assert.equal(isFreshFullAttempt({ ...full, redo: true }), false);
  assert.equal(isFreshFullAttempt({ ...full, fresh: false }), false);
  assert.equal(isFreshFullAttempt({ ...full, normalConditions: undefined }), false);
  assert.equal(isFreshFullAttempt({ ...full, score: { ...full.score, raw40: null } }), false);
  assert.equal(isFreshFullAttempt({ ...full, questions: Array(40).fill(full.questions[0]) }), false);
  assert.equal(isFreshFullAttempt({ ...full, questions: Array(40).fill(null) }), false);
  const legacy = { ...full, recordingMode: 'answer-entry', normalConditions: undefined };
  assert.equal(isFreshFullAttempt(legacy), true);
  assert.equal(getStats(state).reading.raw40.length, state.attempts.filter(isFreshFullAttempt).length);
});

test('听力按连续题型块推进，每块有目标和检查标准，复盘不产生新题', () => {
  assert.deepEqual(LISTENING_BLOCKS.map(block => [block.id, block.from, block.to]), [
    ['fill', 1, 6], ['single', 7, 10], ['map', 11, 13], ['matching', 14, 16],
    ['choice', 17, 19], ['integration', 20, 23], ['exam', 24, 30],
  ]);
  for (const block of LISTENING_BLOCKS) {
    assert.ok(block.goal.length > 10 && block.readyWhen.length > 10);
    const entries = DAYS.filter(day => day.day >= block.from && day.day <= block.to);
    assert.deepEqual(entries.filter(day => ['practice', 'diagnostic', 'mock'].includes(day.listening.kind)).map(day => day.day), block.practiceDays);
    for (const entry of entries) {
      assert.equal(entry.listening.blockId, block.id);
      assert.ok(entry.listening.focus.length > 5);
      assert.ok(entry.listening.successCheck.length > 5);
    }
  }
  const reviewPairs = [[6, 5], [13, 12], [25, 24], [28, 27], [30, 29]];
  for (const [reviewDay, practiceDay] of reviewPairs) {
    const review = DAYS[reviewDay - 1].listening;
    assert.equal(review.kind, 'analysis');
    assert.equal(review.sourceDay, practiceDay);
    assert.deepEqual(review.resources, DAYS[practiceDay - 1].listening.resources);
    assert.deepEqual(questionsFor({ ...review, type: 'listening' }), []);
    assert.equal(review.listeningPlan.newQuestions, 0);
    assert.equal(review.listeningPlan.firstPassMinutes, 0);
  }
  assert.equal(DAYS[6].listening.methodId, 'l-single');
  assert.equal(DAYS[10].listening.methodId, 'l-map');
  assert.equal(DAYS[13].listening.methodId, 'l-matching');
  assert.equal(DAYS[18].listening.methodId, 'l-flow');
});

test('听力重排保持原阅读教材范围、诊断、模考及复盘来源', () => {
  const expected = [
    ['practice', '17/1/1/1/6'], ['diagnostic', '19/1//1/40'], ['practice', '17/2/1/1/5'],
    ['practice', '16/1/1/8/13'], ['practice', '17/2/2/24/26+17/3/2/23/26'], ['practice', '16/2/1/9/13'],
    ['practice', '17/3/1/1/5+17/4/1/7/13+16/3/1/6/13'], ['practice', '16/1/3/31/34+17/2/3/37/40'],
    ['practice', '16/4/1/1/6+16/4/1/11/13'], ['practice', '17/1/1/7/13'], ['practice', '17/2/1/6/13'],
    ['practice', '16/2/2/21/26'], ['practice', '16/2/1/1/13'], ['diagnostic', '19/2//1/40'],
    ['analysis', '19/2//1/40', 14], ['practice', '15/3/3/27/31'], ['practice', '16/1/3/35/40'],
    ['practice', '16/1/2/14/20'], ['practice', '16/3/2/14/19'], ['practice', '16/2/2/14/16+16/3/2/23/26'],
    ['practice', '17/3/3/27/40'], ['mock', '18/1//1/40'], ['analysis', '18/1//1/40', 22],
    ['review', '', 22], ['mock', '18/2//1/40'], ['analysis', '18/2//1/40', 25],
    ['mock', '18/3//1/40'], ['analysis', '18/3//1/40', 27], ['mock', '18/4//1/40'], ['wrapup', ''],
  ];
  const actual = DAYS.map(({ reading }) => [reading.kind,
    reading.resources.map(resource => [resource.book, resource.test, resource.unit, resource.from, resource.to].join('/')).join('+'),
    ...(reading.sourceDay === undefined ? [] : [reading.sourceDay])]);
  assert.deepEqual(actual, expected);
});

test('旧单选块快照继续按旧规则判断，未完成两组单选或只勾复盘不触发', () => {
  const low = createState();
  const oldSingle = day => task('listening', day, day === 11 ? { book: 16, test: 1, from: 11, to: 14, kind: 'practice' } : { book: 17, test: 1, from: 21, to: 26, kind: 'practice' });
  finish(low, oldSingle(11), 2);
  completeTask(low, 'd12-listening');
  assert.equal(getAdaptation(low, { type: 'listening', day: 15 }), null);
  assert.equal(low.attempts.length, 1);
  finish(low, oldSingle(13), 4);
  completeTask(low, 'd14-listening');
  for (const day of [15, 16, 17]) {
    const adaptation = getAdaptation(low, { type: 'listening', day });
    assert.equal(adaptation.minutes, 20);
    assert.equal(adaptation.replacement, true);
    assert.equal(adaptation.additionalMinutes, 0);
    assert.match(adaptation.reason, /6\/10/);
    assert.match(adaptation.action, /单选/);
    assert.equal(tasksForDay(low, day)[1].minutes, DAYS[day - 1].listening.minutes);
  }
  assert.equal(getAdaptation(low, { type: 'listening', day: 18 }), null);
  assert.equal(low.attempts.some(attempt => attempt.day === 14), false);
  const threshold = createState();
  finish(threshold, oldSingle(11), 3);
  finish(threshold, oldSingle(13), 4);
  assert.equal(getAdaptation(threshold, { type: 'listening', day: 15 }), null);
  const unrelated = createState();
  finish(unrelated, task('listening', 11, { book: 17, test: 1, from: 15, to: 20, kind: 'practice' }), 0);
  finish(unrelated, task('listening', 13, { book: 16, test: 1, from: 31, to: 35, kind: 'practice' }), 0);
  assert.equal(getAdaptation(unrelated, { type: 'listening', day: 15 }), null);
});

test('旧版第14组20题或40题检查优先于新版单选块，达到门槛不误补强', () => {
  for (const [total, correct] of [[20, 14], [40, 23]]) {
    const state = createState();
    finish(state, task('listening', 11, { book: 16, test: 1, from: 11, to: 14, kind: 'practice' }), 0);
    finish(state, task('listening', 13, { book: 17, test: 1, from: 21, to: 26, kind: 'practice' }), 0);
    finish(state, task('listening', 14, { book: 19, test: 2, to: total, kind: total === 40 ? 'diagnostic' : 'practice' }), correct);
    assert.equal(getAdaptation(state, { type: 'listening', day: 15 }), null);
  }
  const state = createState();
  finish(state, task('listening', 7, { book: 17, test: 2, from: 1, to: 10, kind: 'practice' }), 6);
  for (const day of [8, 9, 10]) {
    const adaptation = getAdaptation(state, { type: 'listening', day });
    assert.equal(adaptation.minutes, 20);
    assert.equal(adaptation.replacement, true);
    assert.equal(adaptation.additionalMinutes, 0);
  }
  assert.equal(getAdaptation(state, { type: 'listening', day: 11 }), null);
});

test('已开始题组快照保存原题型、方法、来源、预算与教材，刷新和重做不套新课程', () => {
  let state = createState();
  const oldTask = { ...task('listening', 11, { book: 17, test: 1, from: 15, to: 20, kind: 'practice' }),
    title: '旧多选练习', methodId: 'l-choice-mixed', minutes: 60, blockId: 'legacy-choice',
    focus: '旧任务的多选目标', successCheck: '逐个解释旧题证据', sourceDay: 7,
    listeningPlan: { newQuestions: 6, firstPassMinutes: 10, reviewMinutes: 25, spellingMinutes: 10, recallMinutes: 15,
      segments: 2, segmentSeconds: 20, dictationSentences: 1, instruction: '继续原题组，不换题。' } };
  const draft = startAttempt(state, oldTask);
  draft.questions[0].correct = false;
  state = normalizeState(JSON.parse(JSON.stringify(state)));
  const resumedTask = tasksForDay(state, 11)[1];
  for (const key of ['title', 'kind', 'methodId', 'minutes', 'blockId', 'focus', 'successCheck', 'sourceDay', 'listeningPlan', 'resources']) assert.deepEqual(resumedTask[key], oldTask[key]);
  const resolved = resolveTask(state, resumedTask);
  assert.equal(questionsFor(resolved).length, 6);
  assert.equal(startAttempt(state, resolved).id, draft.id);
  const first = finish(state, resolved, 5);
  const redo = startAttempt(state, tasksForDay(state, 11)[1]);
  assert.equal(redo.redo, true);
  assert.equal(redo.methodId, 'l-choice-mixed');
  assert.deepEqual(redo.taskSnapshot.listeningPlan, oldTask.listeningPlan);
  assert.deepEqual(redo.resources, first.resources);
  assert.equal(redo.questions.length, 6);
});

test('无完整快照的旧草稿保留已知元数据，不套用新复盘来源或假造新题型', () => {
  const legacy = normalizeState({ attempts: [{ id: 'old-d14', taskId: 'd14-listening', subject: 'listening', day: 14,
    kind: 'practice', title: '旧20题检查', methodId: 'l-half-check', minutes: 75, startedAt: '2026-10-19T08:00:00Z',
    resources: [{ book: 16, test: 4, unit: null, from: 1, to: 20 }],
    questions: Array.from({ length: 20 }, (_, index) => ({ id: `listening-16-4-${index + 1}`, book: 16, test: 4, number: index + 1, correct: null })) }] });
  const restored = resolveTask(legacy, tasksForDay(legacy, 14)[1]);
  assert.equal(restored.kind, 'practice');
  assert.equal(restored.methodId, 'l-half-check');
  assert.equal(restored.title, '旧20题检查');
  assert.equal(restored.minutes, 75);
  assert.equal(restored.sourceDay, undefined);
  assert.equal(restored.blockId, undefined);
  assert.equal(restored.listeningPlan, undefined);
  assert.equal(questionsFor(restored).length, 20);
  assert.equal(getSelectedTask(legacy).id, 'd14-listening');
});

test('旧草稿、成绩和复盘笔记自动迁移为已领取，保留历史词汇但不再计入任务进度', () => {
  const state = normalizeState({ selectedTaskId: 'd3-listening', completed: { 'd1-reading': '2026-10-19T08:00:00Z', 'd1-vocabulary': '2026-10-19T08:00:00Z', 'd1-reflection': '2026-10-19T08:00:00Z' },
    drafts: { 'd3-listening': 'draft', 'd2-vocabulary': 'invalid-old-task' },
    taskNotes: { 'd2-listening': { text: '已做复盘' }, 'd4-listening': { text: '', checks: [] } },
    vocabulary: [{ id: 'word', word: 'practice', meaning: '练习', day: 1 }], reflections: { 1: { learned: '旧笔记' } } });
  assert.deepEqual(Object.keys(state.claimedTasks).sort(), ['d1-reading', 'd2-listening', 'd3-listening']);
  assert.equal(state.vocabulary[0].word, 'practice');
  assert.equal(state.reflections[1].learned, '旧笔记');
  assert.equal(getStats(state).completedTasks, 1);
  assert.equal(getStats(state).totalTasks, 60);
  assert.equal(getStats(state).completedDays, undefined);
  assert.equal(getSelectedTask(state).id, 'd3-listening');
  assert.equal(subjectProgress(state, 'listening').activeTask.id, 'd2-listening');
  assert.equal(subjectProgress(state, 'reading').nextTask.id, 'd2-reading');
  assert.equal(normalizeState({ selectedTaskId: 'd1-vocabulary' }).selectedTaskId, null);
});

test('旧版已领取听力到期复习快照保持最多10题，不变成新版整卷复盘或新增错题', () => {
  let state = createState();
  for (let day = 1; day <= 27; day++) completeTask(state, `d${day}-listening`);
  const full = finish(state, tasksForDay(state, 27)[1], 28);
  assert.equal(full.questions.length, 40);
  state.reviews = Array.from({ length: 12 }, (_, index) => ({ id: `review${index + 1}`, questionId: `listening-17-1-${index + 1}`, subject: 'listening',
    book: 17, test: 1, unit: 1, number: index + 1, label: `Q${index + 1}`, dueDate: '2020-01-01',
    createdAt: '2020-01-01T08:00:00Z', failures: 1, stage: 0, completed: false }));
  const legacyReview = {
    id: 'd28-listening', day: 28, type: 'listening', subject: 'listening', kind: 'review',
    title: '旧版到期错题回忆', methodId: 'l-review', minutes: 50, curriculumVersion: 'listening-v2',
    reviewItems: dueReviews(state).filter(review => review.subject === 'listening').slice(0, 10), reviewLimit: 10,
    resources: [{ book: 17, test: 1, unit: 1, from: 1, to: 10 }],
  };
  state.claimedTasks['d28-listening'] = '2026-10-20T08:00:00Z';
  state.assignments['d28-listening'] = { resources: legacyReview.resources, taskSnapshot: legacyReview };
  state.taskNotes['d28-listening'] = { text: '已经开始回忆错题', checks: [true] };
  const claimed = claimTask(state, 'listening');
  assert.equal(claimed.day, 28);
  assert.equal(questionsFor(claimed).length, 10);
  assert.equal(claimed.resources.some(resource => resource.from === 1 && resource.to === 40), false);
  const frozenIds = questionsFor(claimed).map(question => question.id);
  state.reviews.forEach(review => review.completed = true);
  state.reviews.push({ ...state.reviews[11], id: 'new-review', questionId: 'listening-17-1-30', number: 30, completed: false });
  state = normalizeState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(questionsFor(tasksForDay(state, 28)[1]).map(question => question.id), frozenIds);
  assert.deepEqual(startAttempt(state, getSelectedTask(state)).questions.map(question => question.id), frozenIds);
  const empty = createState();
  for (let day = 1; day <= 27; day++) completeTask(empty, `d${day}-listening`);
  empty.claimedTasks['d28-listening'] = '2026-10-20T08:00:00Z';
  empty.assignments['d28-listening'] = { resources: [], taskSnapshot: { ...legacyReview, resources: [], reviewItems: [] } };
  empty.taskNotes['d28-listening'] = { text: '旧复习笔记', checks: [] };
  const noDue = claimTask(empty, 'listening');
  assert.deepEqual(questionsFor(noDue), []);
  assert.deepEqual(noDue.resources, []);
});

test('旧general复盘草稿迁移保持原来源、笔记和勾选，不变成新地图或新整卷', () => {
  for (const total of [20, 40]) {
    const sourceTask = task('listening', 14, { book: total === 40 ? 20 : 16, test: total === 40 ? 3 : 4, to: total,
      kind: total === 40 ? 'diagnostic' : 'practice' });
    const old = { id: 'legacy-check', taskId: sourceTask.id, subject: 'listening', day: 14, kind: sourceTask.kind,
      resources: sourceTask.resources, questions: questionsFor(sourceTask), startedAt: '2026-10-18T08:00:00Z',
      completedAt: '2026-10-18T09:00:00Z', score: { correct: 12, total } };
    let state = normalizeState({ selectedTaskId: 'd15-listening', attempts: [old],
      taskNotes: { 'd15-listening': { text: '改口后的信息才是答案', checks: [true, false, true] } } });
    const restored = tasksForDay(state, 15)[1];
    assert.equal(restored.kind, 'analysis');
    assert.equal(restored.sourceDay, 14);
    assert.equal(restored.analysisOf, old.id);
    assert.deepEqual(restored.resources, old.resources);
    assert.equal(restored.minutes, 60);
    assert.deepEqual(questionsFor(restored), []);
    assert.equal(state.taskNotes['d15-listening'].text, '改口后的信息才是答案');
    assert.deepEqual(state.taskNotes['d15-listening'].checks, [true, false, true]);
    assert.equal(getSelectedTask(state).id, 'd15-listening');
    state = normalizeState(JSON.parse(JSON.stringify(state)));
    assert.equal(tasksForDay(state, 15)[1].sourceDay, 14);
    assert.equal(state.attempts.length, 1);
  }
  const fallback = normalizeState({ selectedTaskId: 'd26-listening', taskNotes: {
    'd26-listening': { text: '区分错选项的对象', checks: [true] }, 'd15-listening': { text: '', checks: [false] },
  } });
  const review = tasksForDay(fallback, 26)[1];
  assert.equal(review.kind, 'analysis');
  assert.equal(review.sourceDay, 25);
  assert.equal(review.resources[0].book, 16);
  assert.equal(review.resources[0].test, 2);
  assert.deepEqual([review.resources[0].from, review.resources[0].to], [11, 20]);
  assert.equal(review.minutes, 60);
  assert.equal(fallback.claimedTasks['d15-listening'], undefined);
  assert.equal(fallback.assignments['d15-listening'], undefined);
  assert.equal(fallback.attempts.length, 0);
  const current = normalizeState({ claimedTasks: {}, taskNotes: { 'd15-listening': { text: '新地图笔记', checks: [true] } } });
  assert.equal(tasksForDay(current, 15)[1].kind, 'practice');
  assert.equal(tasksForDay(current, 15)[1].methodId, 'l-matching');
});

test('已领取整卷遇到污染后，替补卷同时用于继续、路线预览与开始记录', () => {
  let state = createState();
  for (let day = 1; day <= 23; day++) completeTask(state, `d${day}-listening`);
  const claimed = claimTask(state, 'listening');
  assert.equal(claimed.day, 24);
  assert.equal(claimed.resources[0].book, 19);
  assert.equal(claimed.resources[0].test, 2);
  setExposure(state, 'listening', 19, 2, true);
  const replacement = resolveTask(state, getSelectedTask(state));
  assert.equal(replacement.resources[0].test, 3);
  assert.equal(state.attempts.length, 0);
  assert.ok(state.assignments[claimed.id].taskSnapshot);
  state = normalizeState(JSON.parse(JSON.stringify(state)));
  const preview = tasksForDay(state, 24)[1];
  assert.deepEqual(preview.resources, replacement.resources);
  assert.equal(preview.replacement, replacement.replacement);
  assert.equal(preview.fresh, true);
  assert.deepEqual(startAttempt(state, getSelectedTask(state)).resources, replacement.resources);
});

function listeningProfile(state, partScores) {
  const selected = tasksForDay(state, 24)[1];
  const attempt = startAttempt(state, selected);
  attempt.questions.forEach(question => {
    const part = Math.floor((question.number - 1) / 10);
    question.correct = (question.number - 1) % 10 < partScores[part];
  });
  attempt.normalConditions = true;
  finishAttempt(state, attempt.id);
  return attempt;
}

test('第26组依据第24组实际逐题结果选择一个Part，按基础优先且不额外加时', () => {
  const cases = [
    [[6, 4, 4, 4], 1, 3, 'l-form'],
    [[7, 5, 4, 4], 2, 3, 'l-part2-mixed'],
    [[7, 6, 4, 5], 4, 2, 'l-notes'],
    [[7, 6, 2, 6], 3, 4, 'l-academic-mixed'],
    [[10, 10, 10, 10], 3, 4, 'l-academic-mixed'],
  ];
  for (const [scores, part, paper, method] of cases) {
    const state = createState(), diagnostic = listeningProfile(state, scores);
    // A cached aggregate cannot override the actual question marks.
    diagnostic.score.correct = 40;
    const selected = tasksForDay(state, 26)[1];
    assert.equal(selected.adaptiveSelection.part, part);
    assert.equal(selected.adaptiveSelection.diagnosticAttemptId, diagnostic.id);
    assert.deepEqual(selected.adaptiveSelection.partScores, scores);
    assert.equal(selected.methodId, method);
    assert.equal(selected.minutes, 35);
    assert.deepEqual(selected.resources.map(resource => [resource.book, resource.test, resource.unit, resource.from, resource.to]),
      [[17, paper, part, (part - 1) * 10 + 1, part * 10]]);
    assert.match(selected.resources[0].sourceUrl, new RegExp(`academic-listening-test-${paper}/$`));
    assert.equal(questionsFor(selected).length, 10);
    assert.equal(selected.adaptation.additionalMinutes, 0);
    assert.equal(selected.adaptation.minutes, 0);
  }
});

test('未完成、缺少逐题对错或只有汇总分的诊断不伪造补强判断', () => {
  for (const mode of ['none', 'active', 'aggregate', 'incomplete']) {
    const state = createState();
    if (mode !== 'none') {
      const diagnostic = startAttempt(state, tasksForDay(state, 24)[1]);
      diagnostic.score = { correct: 35, total: 40 };
      if (mode !== 'active') diagnostic.completedAt = new Date().toISOString();
      if (mode === 'incomplete') diagnostic.questions.forEach((question, index) => question.correct = index === 39 ? null : true);
    }
    const selected = tasksForDay(state, 26)[1];
    assert.equal(selected.adaptiveSelection.part, 1);
    assert.equal(selected.adaptiveSelection.diagnosticAttemptId, null);
    assert.match(selected.adaptiveSelection.reason, /尚无.*不是根据诊断成绩/);
    assert.equal(selected.adaptation, null);
  }
});

test('第26组领取即冻结补强教材和判断，后续诊断重做与刷新不静默换题', () => {
  let state = createState();
  listeningProfile(state, [6, 8, 8, 8]);
  for (let day = 1; day <= 25; day++) completeTask(state, `d${day}-listening`);
  const claimed = claimTask(state, 'listening');
  assert.equal(claimed.adaptiveSelection.part, 1);
  listeningProfile(state, [10, 10, 10, 10]);
  state = normalizeState(JSON.parse(JSON.stringify(state)));
  const restored = tasksForDay(state, 26)[1];
  assert.deepEqual(restored.resources, claimed.resources);
  assert.deepEqual(restored.adaptiveSelection, claimed.adaptiveSelection);
  assert.equal(restored.adaptation.reason, claimed.adaptiveSelection.reason);
  const attempt = startAttempt(state, restored);
  assert.deepEqual(attempt.resources, claimed.resources);
  assert.deepEqual(attempt.taskSnapshot.adaptiveSelection, claimed.adaptiveSelection);
  assert.equal(attempt.questions.length, 10);
});

test('新版不按旧第7、11、13、14组编号塞入补强，仅在第6组给零加时建议', () => {
  const state = createState();
  finish(state, task('listening', 7, { book: 17, test: 2, to: 10, kind: 'practice' }), 0);
  finish(state, task('listening', 14, { book: 19, test: 2 }), 0);
  for (const day of [8, 9, 10, 15, 16, 17]) assert.equal(tasksForDay(state, day)[1].adaptation, null);
  finish(state, tasksForDay(state, 5)[1], 6);
  const review = tasksForDay(state, 6)[1];
  assert.equal(review.adaptation.minutes, 0);
  assert.equal(review.adaptation.additionalMinutes, 0);
  assert.match(review.adaptation.reason, /6\/10/);
  assert.equal(review.minutes, DAYS[5].listening.minutes);
  const threshold = createState();
  finish(threshold, tasksForDay(threshold, 5)[1], 7);
  assert.equal(tasksForDay(threshold, 6)[1].adaptation, null);
});

test('仅领取未开始的旧听力卡自动采用新版10题预算，阅读快照保持原样', () => {
  let state = createState();
  const old = { ...task('listening', 1, { book: 16, test: 1, to: 5, kind: 'practice' }), title: '旧版5题', minutes: 45,
    methodId: 'l-form', curriculumVersion: 'listening-v2' };
  state.claimedTasks[old.id] = '2026-10-20T08:00:00Z';
  state.assignments[old.id] = { resources: old.resources, taskSnapshot: old };
  state.taskNotes[old.id] = { text: '   ', checks: [false] };
  const reading = claimTask(state, 'reading');
  const oldReadingSnapshot = JSON.stringify(state.assignments[reading.id]);
  state = normalizeState(JSON.parse(JSON.stringify(state)));
  const upgraded = tasksForDay(state, 1)[1];
  assert.equal(upgraded.curriculumVersion, 'listening-v3');
  assert.equal(questionsFor(upgraded).length, 10);
  assert.equal(upgraded.minutes, 30);
  assert.equal(resolveTask(state, upgraded).minutes, 30);
  state.taskNotes[old.id] = { text: '按新版领取后补的笔记', checks: [true] };
  assert.equal(tasksForDay(state, 1)[1].minutes, 30);
  assert.equal(startAttempt(state, upgraded).questions.length, 10);
  assert.equal(state.assignments[old.id].taskSnapshot.curriculumVersion, 'listening-v3');
  assert.equal(JSON.stringify(state.assignments[reading.id]), oldReadingSnapshot);
});

test('旧听力有草稿、成绩、勾选或非空笔记时保留旧教材和预算，不继承新补强规则', () => {
  for (const progress of ['attempt', 'completed', 'draft', 'check', 'note']) {
    const state = createState();
    const old = { ...task('listening', 1, { book: 16, test: 1, to: 5, kind: 'practice' }),
      title: '旧版5题', minutes: 45, methodId: 'l-form' };
    state.claimedTasks[old.id] = '2026-10-20T08:00:00Z';
    state.assignments[old.id] = { resources: old.resources, taskSnapshot: old };
    if (progress === 'attempt') startAttempt(state, old);
    if (progress === 'completed') state.completed[old.id] = '2026-10-20T08:00:00Z';
    if (progress === 'draft') state.drafts[old.id] = 'existing-draft';
    if (progress === 'check') state.taskNotes[old.id] = { text: '', checks: [false, true] };
    if (progress === 'note') state.taskNotes[old.id] = { text: '已完成听辨', checks: [] };
    const restored = tasksForDay(normalizeState(state), 1)[1];
    assert.equal(restored.curriculumVersion, 'listening-legacy');
    assert.equal(restored.title, old.title);
    assert.equal(restored.minutes, 45);
    assert.deepEqual(restored.resources, old.resources);
    assert.equal(questionsFor(restored).length, 5);
    assert.equal(restored.adaptivePractice, undefined);
  }
});

test('专项材料只在两处明确共享Part录音，地图位置准确且无重复作答题号', () => {
  const partUses = new Map(), questionUses = new Set(), repeats = [];
  for (const day of DAYS) {
    const lesson = day.listening;
    if (lesson.kind !== 'practice') continue;
    for (const resource of lesson.resources) {
      const key = `${resource.book}/${resource.test}/${resource.unit}`;
      if (partUses.has(key)) repeats.push([day.day, partUses.get(key)]);
      else partUses.set(key, day.day);
      for (let number = resource.from; number <= resource.to; number++) {
        const question = `${resource.book}/${resource.test}/${number}`;
        assert.ok(!questionUses.has(question), `第${day.day}组重复安排了${question}`);
        questionUses.add(question);
      }
    }
  }
  assert.deepEqual(repeats, [[12, 10], [17, 9]]);
  assert.deepEqual(DAYS.filter(day => day.listening.exposureNote).map(day => day.day), [12, 17]);
  for (const [day, paper] of [[11, 1], [12, 4]]) {
    const lesson = DAYS[day - 1].listening;
    assert.equal(lesson.methodId, 'l-map');
    assert.deepEqual(lesson.resources.map(resource => [resource.book, resource.test, resource.unit, resource.from, resource.to]),
      [[16, paper, 2, 15, 20]]);
  }
});

test('旧任务快照不会继承当前课程的共享录音说明，新任务的说明会随快照保留', () => {
  const legacy = createState();
  const old = { ...task('listening', 12, { book: 16, test: 1, from: 11, to: 14, kind: 'practice' }),
    title: '旧单选练习', minutes: 50, methodId: 'l-single' };
  startAttempt(legacy, old);
  assert.equal(tasksForDay(normalizeState(legacy), 12)[1].exposureNote, undefined);
  const current = createState();
  const selected = tasksForDay(current, 12)[1];
  const attempt = startAttempt(current, selected);
  assert.ok(attempt.taskSnapshot.exposureNote);
  assert.equal(tasksForDay(normalizeState(current), 12)[1].exposureNote, selected.exposureNote);
});
