import { DAYS } from './curriculum.js';

const DAY_MS = 86400000;
const SUBJECTS = ['reading', 'listening'];
const FALLBACKS = [[19, 3], [19, 4], [20, 1], [20, 2], [20, 3], [20, 4]];
const copy = value => JSON.parse(JSON.stringify(value));
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const uid = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const instant = value => (value instanceof Date ? value : new Date(value ?? Date.now())).toISOString();
const exposureKey = (subject, book, test) => `${subject}-${book}-${test}`;
const TASK_ID = /^d([1-9]|[12]\d|30)-(reading|listening|vocabulary|reflection)$/;

function validTaskId(value) {
  const match = typeof value === 'string' && value.match(TASK_ID);
  return !!match && DAYS.some(day => day.day === Number(match[1]));
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function validInstant(value) {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

function scoreValue(value, fallback) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 9 ? number : fallback;
}

function cleanResources(value) {
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object' &&
    Number.isInteger(item.book) && item.book > 0 && Number.isInteger(item.test) && item.test >= 1 && item.test <= 4 &&
    Number.isInteger(item.from) && Number.isInteger(item.to) && item.from >= 1 && item.to <= 40 && item.from <= item.to) : [];
}

function validQuestion(value) {
  return value && typeof value === 'object' && typeof value.id === 'string' && value.id.length > 0 &&
    Number.isInteger(value.book) && value.book > 0 && Number.isInteger(value.test) && value.test >= 1 && value.test <= 4 &&
    Number.isInteger(value.number) && value.number >= 1 && value.number <= 40;
}

/** Calendar dates use the learner's local timezone, never UTC truncation. */
export function dateKey(date = new Date()) {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return dateKey();
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function dateNumber(value) {
  const [year, month, day] = dateKey(value).split('-').map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

function addDays(value, days) {
  const [year, month, day] = dateKey(value).split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return `${result.getUTCFullYear()}-${String(result.getUTCMonth() + 1).padStart(2, '0')}-${String(result.getUTCDate()).padStart(2, '0')}`;
}

export function createState() {
  return {
    version: 1,
    profile: { startDate: dateKey(), baseline: 3.5, target: 6.5 },
    completed: {}, drafts: {}, taskNotes: {}, assignments: {}, attempts: [], reviews: [], selectedTaskId: null,
    exposures: {}, vocabulary: [], reflections: {},
  };
}

/** Keep unknown fields so newer cloud records survive older clients. */
export function normalizeState(raw) {
  const source = copy(record(raw));
  const base = createState();
  const importedProfile = record(source.profile);
  const attempts = Array.isArray(source.attempts) ? source.attempts.filter(item => item && typeof item === 'object' &&
    typeof item.id === 'string' && typeof item.taskId === 'string' && SUBJECTS.includes(item.subject)).map(attempt => ({
      ...attempt,
      recordingMode: attempt.recordingMode === 'self-check' ? 'self-check' : 'answer-entry',
      resources: cleanResources(attempt.resources),
      elapsedSeconds: Number.isFinite(Number(attempt.elapsedSeconds)) ? Math.max(0, Number(attempt.elapsedSeconds)) : 0,
      questions: Array.isArray(attempt.questions) ? attempt.questions.filter(validQuestion).map(question => ({
        ...question, ...(Object.hasOwn(question, 'answer') ? { answer: String(question.answer ?? '') } : {}),
        correct: typeof question.correct === 'boolean' ? question.correct : null,
        cause: String(question.cause ?? ''), evidence: String(question.evidence ?? ''),
      })) : [],
      ...(Array.isArray(attempt.originalAnswers) ? { originalAnswers: attempt.originalAnswers.filter(item => item && typeof item.id === 'string').map(item => ({ ...item, answer: String(item.answer ?? '') })) } : {}),
    })) : [];
  const reviews = Array.isArray(source.reviews) ? source.reviews.filter(item => item && typeof item === 'object' &&
    typeof item.id === 'string' && typeof item.questionId === 'string' && SUBJECTS.includes(item.subject) &&
    Number.isInteger(item.book) && item.book > 0 && Number.isInteger(item.test) && item.test >= 1 && item.test <= 4 &&
    Number.isInteger(item.number) && item.number >= 1 && item.number <= 40).map(item => {
      const createdAt = validInstant(item.createdAt) ? item.createdAt : new Date().toISOString();
      return { ...item, createdAt, dueDate: validDate(item.dueDate) ? item.dueDate : addDays(createdAt, 1),
        stage: Number.isInteger(item.stage) && item.stage >= 0 && item.stage <= 3 ? item.stage : 0,
        failures: Number.isInteger(item.failures) && item.failures > 0 ? item.failures : 1,
        completed: item.completed === true, ...(Object.hasOwn(item, 'answer') ? { answer: String(item.answer ?? '') } : {}),
        cause: String(item.cause || '待分析'), evidence: String(item.evidence ?? ''),
        history: Array.isArray(item.history) ? item.history.filter(entry => entry && typeof entry === 'object') : [],
      };
    }) : [];
  const vocabulary = Array.isArray(source.vocabulary) ? source.vocabulary.filter(item => item && typeof item === 'object' &&
    typeof item.word === 'string' && item.word.trim() && Number.isInteger(item.day) && item.day >= 1 && item.day <= 30)
    .map(item => ({ ...item, id: typeof item.id === 'string' ? item.id : uid('word'), meaning: String(item.meaning ?? ''), example: String(item.example ?? '') })) : [];
  const taskNotes = Object.fromEntries(Object.entries(record(source.taskNotes)).map(([key, value]) => [key, {
    ...record(value), text: String(record(value).text ?? ''), checks: Array.isArray(record(value).checks) ? value.checks.map(Boolean) : [],
  }]));
  const reflections = Object.fromEntries(Object.entries(record(source.reflections)).map(([key, value]) => [key, {
    ...record(value), learned: String(record(value).learned ?? ''), next: String(record(value).next ?? ''),
  }]));
  const assignments = Object.fromEntries(Object.entries(record(source.assignments)).filter(([, value]) => value && typeof value === 'object')
    .map(([key, value]) => [key, { ...value, resources: cleanResources(value.resources) }]));
  return {
    ...base, ...source, version: 1,
    selectedTaskId: validTaskId(source.selectedTaskId) ? source.selectedTaskId : null,
    profile: { ...base.profile, ...importedProfile,
      startDate: validDate(importedProfile.startDate) ? importedProfile.startDate : base.profile.startDate,
      baseline: scoreValue(importedProfile.baseline, 3.5), target: scoreValue(importedProfile.target, 6.5),
    },
    completed: copy(record(source.completed)),
    drafts: copy(record(source.drafts)),
    taskNotes, assignments,
    exposures: copy(record(source.exposures)),
    reflections, attempts, reviews, vocabulary,
  };
}

export function calendarInfo(state, now = new Date()) {
  const elapsed = dateNumber(now) - dateNumber(state.profile.startDate);
  const completedDays = DAYS.filter(day => ['reading', 'listening', 'vocabulary', 'reflection'].every(type => state.completed[`d${day.day}-${type}`])).length;
  return {
    elapsedDay: Math.max(0, elapsed + 1), remaining: Math.max(0, 30 - Math.max(0, elapsed)),
    deadline: addDays(state.profile.startDate, 29), completedDays,
  };
}

function sourceAttempt(state, day, subject) {
  return state.attempts.find(attempt => attempt.day === day && attempt.subject === subject && attempt.completedAt && !attempt.redo);
}

function selectedReviews(state, subject, limit, now = new Date()) {
  return dueReviews(state, now).filter(review => review.subject === subject).slice(0, limit);
}

export function tasksForDay(state, day) {
  const entry = DAYS.find(item => item.day === Number(day));
  if (!entry) return [];
  const subjectTasks = SUBJECTS.map(subject => {
    const source = entry[subject];
    const task = {
      ...copy(source), id: `d${entry.day}-${subject}`, day: entry.day, type: subject, subject,
      minutes: subject === 'listening' && Number.isFinite(source.minutes) && source.minutes > 0 ? source.minutes : entry.day <= 3 ? 75 : 90,
      resources: copy(source.resources || []),
    };
    if (source.sourceDay) {
      const original = sourceAttempt(state, source.sourceDay, subject);
      if (original) {
        task.resources = copy(original.resources);
        task.analysisOf = original.id;
        if (subject === 'listening' && task.kind === 'analysis') task.title = `复盘第${source.sourceDay}天听力 · 实际${original.questions.length}题`;
      }
    }
    if (entry.day === 24 && task.kind === 'review') {
      task.reviewItems = copy(selectedReviews(state, subject, subject === 'reading' ? 8 : 10));
      // Review tasks still need a usable book location even with no fixed paper.
      const grouped = new Map();
      for (const item of task.reviewItems) {
        const key = `${item.book}-${item.test}-${item.unit ?? ''}`;
        const resource = grouped.get(key) || { book: item.book, test: item.test, unit: item.unit ?? null, from: item.number, to: item.number, questionNumbers: [] };
        resource.from = Math.min(resource.from, item.number);
        resource.to = Math.max(resource.to, item.number);
        resource.questionNumbers.push(item.number);
        grouped.set(key, resource);
      }
      task.resources = [...grouped.values()].flatMap(resource => {
        const numbers = [...new Set(resource.questionNumbers)].sort((a, b) => a - b);
        const ranges = [];
        for (const number of numbers) {
          const previous = ranges.at(-1);
          if (previous && previous.to + 1 === number) {
            previous.to = number;
            previous.questionNumbers.push(number);
          } else ranges.push({ ...resource, from: number, to: number, questionNumbers: [number] });
        }
        return ranges;
      });
      task.reviewLimit = subject === 'reading' ? 8 : 10;
      task.fallback = '错题不足时，复习已记录的同义替换、拼写和精听句，不添加新卷。';
    }
    task.adaptation = getAdaptation(state, task);
    return task;
  });
  return [...subjectTasks, {
    id: `d${entry.day}-vocabulary`, day: entry.day, type: 'vocabulary', kind: 'review',
    title: '到期错题回忆与真题词汇', minutes: 50, reviewMinutes: 20, vocabularyMinutes: 30,
    resources: [], methodId: 'vocabulary', maxNewWords: 20,
    instruction: '先回忆到期错题20分钟，再整理当天真题中的词汇、拼写和同义替换30分钟；每天新增不超过20个。',
  }, {
    id: `d${entry.day}-reflection`, day: entry.day, type: 'reflection', kind: 'analysis',
    title: '学习记录与每日小结', minutes: 10, reflectionMinutes: 10,
    resources: [], methodId: 'reflection',
    instruction: '用10分钟记录今天最主要的错因、仍不理解的句子和明天的改进动作。',
  }];
}

export function getCurrentTask(state) {
  for (const day of DAYS) {
    const task = tasksForDay(state, day.day).find(item => !state.completed[item.id]);
    if (task) return task;
  }
  return null;
}

/** Selection changes the visible task, never the earliest unfinished study day. */
export function getSelectedTask(state) {
  const recommended = getCurrentTask(state);
  if (!recommended) return null;
  return tasksForDay(state, recommended.day).find(task => task.id === state.selectedTaskId) || recommended;
}

export function selectTask(state, taskId) {
  const current = getCurrentTask(state);
  if (!current) throw new Error('本轮30天训练已完成，可在学习记录中回看练习。');
  const selected = validTaskId(taskId) && tasksForDay(state, current.day).find(task => task.id === taskId);
  if (!selected) throw new Error('只能切换当前训练日的任务，请先完成这一天的练习。');
  state.selectedTaskId = selected.id;
  return selected;
}

export function questionsFor(task) {
  if (!SUBJECTS.includes(task.type || task.subject) || ['analysis', 'wrapup'].includes(task.kind)) return [];
  const subject = task.type || task.subject;
  if (Array.isArray(task.reviewItems)) return task.reviewItems.map(review => ({
    id: review.questionId, label: review.label, book: review.book, test: review.test,
    unit: review.unit, number: review.number, subject, reviewId: review.id,
  }));
  const result = [];
  const ids = new Set();
  for (const resource of task.resources || []) {
    const first = Number(resource.from);
    const last = Number(resource.to);
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last > 40 || first > last) continue;
    for (let number = first; number <= last; number++) {
      const id = `${subject}-${resource.book}-${resource.test}-${number}`;
      if (ids.has(id)) continue;
      ids.add(id);
      result.push({ id, label: `剑${resource.book} · T${resource.test} · Q${number}`, book: resource.book, test: resource.test, unit: resource.unit ?? null, number, subject });
    }
  }
  return result;
}

function hasExposure(state, subject, book, test, excludeAttemptId = null) {
  const exposure = state.exposures[exposureKey(subject, book, test)];
  const marked = exposure === true || typeof exposure === 'string' && !!exposure || record(exposure).seen === true;
  return marked || state.attempts.some(attempt => attempt.id !== excludeAttemptId && attempt.subject === subject &&
    (attempt.resources || []).some(resource => resource.book === book && resource.test === test));
}

function bookedElsewhere(state, subject, book, test, taskId) {
  const assigned = Object.entries(state.assignments).some(([id, assignment]) => id !== taskId && id.endsWith(`-${subject}`) &&
    (assignment.resources || []).some(resource => resource.book === book && resource.test === test));
  return assigned || DAYS.some(day => {
    const item = day[subject];
    return `d${day.day}-${subject}` !== taskId && ['diagnostic', 'mock'].includes(item.kind) &&
      (item.resources || []).some(resource => resource.book === book && resource.test === test);
  });
}

/** Resolves and remembers a replacement independently for reading/listening. */
export function resolveTask(state, task) {
  const result = copy(task);
  if (!SUBJECTS.includes(task.type || task.subject)) return { ...result, fresh: false };
  const subject = task.type || task.subject;
  const prior = state.attempts.find(attempt => attempt.taskId === task.id);
  const saved = state.assignments[task.id];
  if (prior) return { ...result, resources: copy(prior.resources), fresh: prior.completedAt ? false : prior.fresh, replacement: saved?.replacement };
  if (!['diagnostic', 'mock'].includes(task.kind)) {
    return { ...result, fresh: (task.resources || []).length > 0 && !(task.resources || []).some(resource => hasExposure(state, subject, resource.book, resource.test)) };
  }
  let resources = copy(saved?.resources || task.resources || []);
  let replacement = saved?.replacement;
  const clean = resources.length > 0 && resources.every(resource => !hasExposure(state, subject, resource.book, resource.test));
  if (!clean) {
    const candidate = FALLBACKS.find(([book, test]) => !hasExposure(state, subject, book, test) && !bookedElsewhere(state, subject, book, test, task.id));
    if (candidate) {
      const [book, test] = candidate;
      const original = task.resources?.[0];
      resources = [{ book, test, unit: null, from: 1, to: 40, verified: true,
        sourceUrl: `https://engnovate.com/ielts-${subject}-tests/cambridge-ielts-${book}-academic-${subject}-test-${test}/` }];
      replacement = `原卷剑${original?.book} T${original?.test}已见，改用剑${book} T${test}。`;
    }
  }
  const fresh = resources.length > 0 && resources.every(resource => !hasExposure(state, subject, resource.book, resource.test));
  if (!fresh) replacement = '备用卷均已见，本次作为复测；成绩不计入首次新卷诊断。';
  state.assignments[task.id] = { resources: copy(resources), fresh, replacement: replacement || null };
  return { ...result, resources, fresh, replacement };
}

export function setExposure(state, subject, book, test, value) {
  if (!SUBJECTS.includes(subject) || !Number.isInteger(Number(book)) || !Number.isInteger(Number(test))) throw new Error('试卷信息无效。');
  const key = exposureKey(subject, Number(book), Number(test));
  if (!value || value === 'unseen') {
    delete state.exposures[key];
    return;
  }
  state.exposures[key] = {
    ...record(value), seen: true, reason: typeof value === 'string' ? value : record(value).reason || '已练习或看过答案/文本',
    updatedAt: new Date().toISOString(),
  };
}

export function startAttempt(state, task, options = {}) {
  const active = state.attempts.find(attempt => attempt.taskId === task.id && !attempt.completedAt);
  if (active) return active;
  const previous = [...state.attempts].reverse().find(attempt => attempt.taskId === task.id && attempt.completedAt);
  const redo = !!previous;
  const resolved = previous ? { ...task, resources: copy(previous.resources), fresh: false } : resolveTask(state, task);
  // A redo is the same paper/questions, even if the dynamic due queue has moved.
  const sourceQuestions = previous ? copy(previous.questions) : questionsFor(resolved);
  const startedAt = new Date().toISOString();
  // Answer entry remains available only for compatibility with existing records.
  const recordingMode = options.recordingMode === 'answer-entry' ? 'answer-entry' : 'self-check';
  const attempt = {
    id: uid('attempt'), taskId: task.id, subject: task.type || task.subject, day: task.day,
    kind: previous?.kind || task.kind, title: previous?.title || task.title || '', methodId: previous?.methodId || task.methodId || '', minutes: previous?.minutes ?? task.minutes,
    resources: copy(resolved.resources || []),
    questions: sourceQuestions.map(question => {
      const { answer, correctAnswer, ...position } = question;
      return { ...position, ...(recordingMode === 'answer-entry' ? { answer: '' } : {}), correct: null, cause: '', evidence: '' };
    }),
    recordingMode, startedAt, submittedAt: recordingMode === 'self-check' ? startedAt : null,
    completedAt: null, elapsedSeconds: 0, durationProvided: false,
    durationSource: recordingMode === 'self-check' ? 'external' : 'legacy-timer',
    fresh: !!resolved.fresh && !redo, redo,
  };
  if (recordingMode === 'answer-entry' && attempt.subject === 'reading' && ['diagnostic', 'mock'].includes(attempt.kind) && attempt.questions.length === 40) {
    attempt.deadline = new Date(new Date(startedAt).getTime() + 3600000).toISOString();
  }
  state.attempts.push(attempt);
  state.drafts[task.id] = attempt.id;
  if (recordingMode === 'self-check') markAttemptExposed(state, attempt);
  return attempt;
}

function requireAttempt(state, attemptId) {
  const attempt = state.attempts.find(item => item.id === attemptId);
  if (!attempt) throw new Error('找不到这次练习，请刷新后重试。');
  return attempt;
}

function markAttemptExposed(state, attempt) {
  for (const resource of attempt.resources || []) {
    setExposure(state, attempt.subject, resource.book, resource.test, { reason: '已开始真题训练', attemptId: attempt.id });
  }
}

/** Switch an existing answer draft to grading without fabricating blank answers. */
export function beginSelfCheck(state, attemptId) {
  const attempt = requireAttempt(state, attemptId);
  if (attempt.completedAt) return attempt;
  const migratingLegacy = attempt.recordingMode !== 'self-check';
  attempt.recordingMode = 'self-check';
  attempt.submittedAt ||= new Date().toISOString();
  if (migratingLegacy && Number(attempt.elapsedSeconds) > 0) {
    attempt.durationProvided = true;
    attempt.durationSource = 'legacy-timer';
  } else {
    attempt.durationProvided ??= false;
    attempt.durationSource ||= 'external';
  }
  markAttemptExposed(state, attempt);
  return attempt;
}

/** Optional duration is copied from the learner's external practice session. */
export function setExternalDuration(state, attemptId, seconds) {
  const attempt = requireAttempt(state, attemptId);
  if (seconds === null || seconds === undefined || seconds === '') {
    attempt.elapsedSeconds = 0;
    attempt.durationProvided = false;
    attempt.durationSource = 'external';
    return attempt;
  }
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) throw new Error('请填写有效的外部做题用时，或留空。');
  attempt.elapsedSeconds = Math.round(seconds);
  attempt.durationProvided = true;
  attempt.durationSource = 'external';
  return attempt;
}

export function submitAttempt(state, attemptId) {
  const attempt = requireAttempt(state, attemptId);
  if (attempt.recordingMode === 'self-check') return beginSelfCheck(state, attemptId);
  if (attempt.submittedAt) return attempt;
  attempt.submittedAt = new Date().toISOString();
  attempt.originalAnswers = attempt.questions.map(question => ({ id: question.id, answer: String(question.answer ?? '') }));
  markAttemptExposed(state, attempt);
  return attempt;
}

function fullPaper(attempt) {
  if (!attempt || !['diagnostic', 'mock'].includes(attempt.kind) || !Array.isArray(attempt.questions) || attempt.questions.length !== 40 || attempt.questions.some(question => !question || typeof question !== 'object')) return false;
  const groups = new Set(attempt.questions.map(question => `${question.book}-${question.test}`));
  const numbers = new Set(attempt.questions.map(question => question.number));
  return groups.size === 1 && numbers.size === 40 && [...numbers].every(number => number >= 1 && number <= 40);
}

function validConditions(attempt) {
  return attempt.recordingMode === 'self-check' ? attempt.normalConditions === true : attempt.normalConditions !== false;
}

/** Single criterion for charts, summaries and record labels. */
export function isFreshFullAttempt(attempt) {
  return !!(fullPaper(attempt) && Number.isFinite(attempt.score?.raw40) && attempt.score.raw40 >= 0 && attempt.score.raw40 <= 40 && attempt.fresh && !attempt.redo && validConditions(attempt));
}

export function finishAttempt(state, attemptId) {
  const attempt = requireAttempt(state, attemptId);
  if (attempt.completedAt) return attempt;
  if (!attempt.submittedAt) throw new Error('请先提交首次答案，再对照教材批改。');
  if (attempt.questions.some(question => typeof question.correct !== 'boolean')) throw new Error('请逐题标记正确或错误，再完成复盘。');
  const completedAt = new Date().toISOString();
  const correct = attempt.questions.filter(question => question.correct).length;
  const total = attempt.questions.length;
  attempt.score = { correct, total, accuracy: total ? Math.round(correct / total * 1000) / 10 : null, raw40: fullPaper(attempt) && validConditions(attempt) && attempt.fresh && !attempt.redo ? correct : null };
  attempt.correctCount = correct;
  attempt.total = total;
  // Reconstruct locked answers so manual grading never overwrites first responses.
  const originals = new Map((attempt.originalAnswers || []).map(item => [item.id, item.answer]));
  for (const question of attempt.questions) {
    if (originals.has(question.id)) question.answer = originals.get(question.id);
    if (question.reviewId) {
      if (!attempt.redo || !question.correct) recordReview(state, question.reviewId, question.correct, new Date(completedAt));
      else attempt.reviewScheduleNote = '重做成绩已保存；答对不会提前推进间隔复习，请按到期日期回忆。';
      continue;
    }
    if (question.correct) continue;
    const existing = state.reviews.find(review => review.questionId === question.id && !review.completed);
    if (existing) {
      existing.failures = (existing.failures || 1) + 1;
      existing.cause = question.cause || existing.cause;
      existing.evidence = question.evidence || existing.evidence;
      existing.dueDate = addDays(completedAt, 1);
      continue;
    }
    state.reviews.push({
      id: uid('review'), questionId: question.id, taskId: attempt.taskId, attemptId: attempt.id,
      subject: attempt.subject, book: question.book, test: question.test, unit: question.unit,
      number: question.number, label: question.label, ...(Object.hasOwn(question, 'answer') ? { answer: question.answer } : {}),
      correctAnswer: question.correctAnswer || '', cause: question.cause || '待分析', evidence: question.evidence || '',
      createdAt: completedAt, dueDate: addDays(completedAt, 1), stage: 0, failures: 1,
      lastReviewedAt: null, completed: false, history: [],
    });
  }
  attempt.completedAt = completedAt;
  markAttemptExposed(state, attempt);
  completeTask(state, attempt.taskId);
  delete state.drafts[attempt.taskId];
  return attempt;
}

export function completeTask(state, taskId) {
  if (!validTaskId(taskId)) throw new Error('训练任务无效。');
  if (!state.completed[taskId]) state.completed[taskId] = new Date().toISOString();
  const current = getCurrentTask(state);
  if (!current) state.selectedTaskId = null;
  else if (!tasksForDay(state, current.day).some(task => task.id === state.selectedTaskId)) state.selectedTaskId = current.id;
  return state.completed[taskId];
}

function reviewSort(a, b) {
  return String(a.dueDate).localeCompare(String(b.dueDate)) || (b.failures || 0) - (a.failures || 0) || String(a.createdAt).localeCompare(String(b.createdAt));
}

export function dueReviews(state, now = new Date()) {
  const today = dateKey(now);
  return state.reviews.filter(review => !review.completed && review.dueDate <= today).sort(reviewSort);
}

export function recordReview(state, reviewId, passed, now = new Date()) {
  const review = state.reviews.find(item => item.id === reviewId);
  if (!review) throw new Error('找不到这道复习题。');
  if (review.completed) return review;
  if (passed && dateKey(now) < review.dueDate) throw new Error(`这道题尚未到期，请在${review.dueDate}或之后再完成下一轮复习。`);
  const reviewedAt = instant(now);
  review.lastReviewedAt = reviewedAt;
  review.history = [...(review.history || []), { reviewedAt, passed: !!passed }];
  if (!passed) {
    review.failures = (review.failures || 1) + 1;
    review.dueDate = addDays(now, 1);
    return review;
  }
  review.stage = (review.stage || 0) + 1;
  if (review.stage >= 3) {
    review.completed = true;
    review.completedAt = reviewedAt;
  } else {
    // The intended intervals are day 1, day 3 and day 7 from the mistake.
    // A late review still leaves at least a day before the next repetition.
    const target = addDays(review.createdAt, review.stage === 1 ? 3 : 7);
    const tomorrow = addDays(now, 1);
    review.dueDate = target > tomorrow ? target : tomorrow;
  }
  return review;
}

export function getAdaptation(state, task) {
  const subject = task.type || task.subject;
  if (!SUBJECTS.includes(subject)) return null;
  const sourceDay = task.day >= 8 && task.day <= 10 ? 7 : task.day >= 15 && task.day <= 17 ? 14 : null;
  if (!sourceDay) return null;
  const attempts = state.attempts.filter(attempt => attempt.day === sourceDay && attempt.subject === subject && attempt.completedAt && !attempt.redo && attempt.score?.total > 0);
  if (!attempts.length) return null;
  const total = attempts.reduce((sum, attempt) => sum + attempt.score.total, 0);
  const correct = attempts.reduce((sum, attempt) => sum + attempt.score.correct, 0);
  const listeningCheckpoint = sourceDay === 14 && subject === 'listening';
  const legacyListeningCheckpoint = listeningCheckpoint && total === 40;
  const required = sourceDay === 7 ? correct / total < .7 : listeningCheckpoint && !legacyListeningCheckpoint ? total === 20 && correct / total < .7 : total === 40 && correct < 23;
  if (!required) return null;
  const minutes = sourceDay === 7 || listeningCheckpoint && !legacyListeningCheckpoint ? 20 : 30;
  return {
    minutes, reason: sourceDay === 7 ? `第7天${subject === 'reading' ? '阅读' : '听力'}专项正确率${Math.round(correct / total * 100)}%，低于70%。` : legacyListeningCheckpoint ? `第14天旧版听力完整诊断${correct}/40，少于23题。` : listeningCheckpoint ? `第14天听力专项检查${correct}/20，正确率${Math.round(correct / total * 100)}%，低于70%。` : `第14天阅读诊断${correct}/40，少于23题。`,
    action: subject === 'reading' ? '重做基础填空、定位答案句并精读' : '复听基础片段、检查拼写与答案预测',
  };
}

function subjectStats(state, subject) {
  const done = state.attempts.filter(attempt => attempt.subject === subject && attempt.completedAt && attempt.score);
  const full = done.filter(attempt => fullPaper(attempt));
  const raw40 = full.filter(isFreshFullAttempt).map(attempt => ({
    id: attempt.id, day: attempt.day, correct: attempt.score.correct, total: 40,
    completedAt: attempt.completedAt, resources: copy(attempt.resources), kind: attempt.kind,
  }));
  const practice = done.filter(attempt => !['diagnostic', 'mock'].includes(attempt.kind) && !attempt.redo && attempt.kind !== 'review');
  const practiceTotal = practice.reduce((sum, attempt) => sum + attempt.score.total, 0);
  const practiceCorrect = practice.reduce((sum, attempt) => sum + attempt.score.correct, 0);
  const causes = {};
  for (const attempt of done) for (const question of attempt.questions) {
    if (question.correct === false) causes[question.cause || '待分析'] = (causes[question.cause || '待分析'] || 0) + 1;
  }
  return {
    raw40, latest40: raw40.at(-1) || null,
    practiceAccuracy: practiceTotal ? Math.round(practiceCorrect / practiceTotal * 1000) / 10 : null,
    practiceTotal, practiceCorrect, completedAttempts: done.length,
    redoAttempts: done.filter(attempt => attempt.redo).length,
    retest40: full.filter(attempt => !isFreshFullAttempt(attempt)).map(attempt => ({ id: attempt.id, day: attempt.day, correct: attempt.score.correct, total: 40, completedAt: attempt.completedAt })),
    causes: Object.entries(causes).map(([cause, count]) => ({ cause, count })).sort((a, b) => b.count - a.count),
    latest: done.at(-1) || null,
    target: 30, targetGap: raw40.length ? Math.max(0, 30 - raw40.at(-1).correct) : null,
  };
}

export function getStats(state) {
  const calendar = calendarInfo(state);
  const dates = new Set(Object.values(state.completed).map(value => dateKey(value)));
  let day = dateKey();
  if (!dates.has(day)) day = addDays(day, -1);
  let streak = 0;
  while (dates.has(day)) { streak++; day = addDays(day, -1); }
  return {
    completedDays: calendar.completedDays,
    completedTasks: Object.keys(state.completed).filter(key => /^d(?:[1-9]|[12]\d|30)-(reading|listening|vocabulary|reflection)$/.test(key)).length,
    totalTasks: DAYS.length * 4, reading: subjectStats(state, 'reading'), listening: subjectStats(state, 'listening'),
    dueCount: dueReviews(state).length, totalAttempts: state.attempts.filter(attempt => attempt.completedAt).length,
    totalVocabulary: state.vocabulary.length, streak,
    elapsedSeconds: state.attempts.reduce((sum, attempt) => sum + (Number(attempt.elapsedSeconds) || 0), 0),
  };
}
