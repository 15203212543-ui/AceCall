import test from 'node:test';
import assert from 'node:assert/strict';
import { directInterviewQuestions } from '../public/interview-questions.mjs';

test('spoken interviewer lines become direct questions', () => {
  assert.deepEqual(directInterviewQuestions([
    '哎你在上一家具体是负责哪一块啊，结果怎么衡量呢？',
    '胡亚辉：你在上一家具体负责哪一块？',
    '嗯那个你为啥想看机会啊？',
    '我负责交易链路。'
  ]), [
    '你在上一家具体负责哪一块？',
    '结果怎么衡量？',
    '你为什么想看机会？'
  ]);
});
