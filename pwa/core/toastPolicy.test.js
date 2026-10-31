import assert from 'node:assert/strict';
import test from 'node:test';
import { userFacingToastMessage } from './toastPolicy.js';

test('technical errors are replaced with action-specific product copy', () => {
  assert.equal(
    userFacingToastMessage('error', '切换失败', 'virtualPersonId is required'),
    '没有切换成功，当前对话没有变化。请稍后再试。',
  );
  assert.doesNotMatch(
    userFacingToastMessage('error', '未知错误', 'provider token=secret'),
    /provider|token|secret/,
  );
});

test('non-error toast copy is preserved', () => {
  assert.equal(userFacingToastMessage('success', '已接入对话', '诺诺会继续聊'), '诺诺会继续聊');
});

test('curated product copy passes through without masking', () => {
  assert.equal(
    userFacingToastMessage('error', '没有保存', '需要填写标题。', { curated: true }),
    '需要填写标题。',
  );
  assert.equal(
    userFacingToastMessage('error', '没有保存', 'life context service unavailable'),
    '刚才的操作没有完成。当前状态已经保留，请稍后再试。',
  );
});
