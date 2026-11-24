// 本地 embedding 模型的固定清单（add-local-semantic-memory-recall）。
// 安装脚本按这份清单下载/复制并逐个校验大小与 sha256；运行时只认清单里的文件，不联网。
// 选型依据：中英混合、无共同字词的改述查询里召回最好（MiniLM 11/12 进前 10；bge-small-zh 英文几乎召回不到）。
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const EMBEDDING_MODEL = Object.freeze({
  id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  revision: '2c4055b12046f11709e9df2c122e59ffbdc2f900',
  dtype: 'q8',
  pooling: 'mean',
  files: Object.freeze([
    { path: 'config.json', size: 673, sha256: '05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7' },
    { path: 'tokenizer_config.json', size: 496, sha256: '3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2' },
    { path: 'tokenizer.json', size: 17082913, sha256: 'b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441' },
    { path: 'onnx/model_quantized.onnx', size: 118308126, sha256: '66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc' },
  ]),
});

/** 模型在模型根下的目录：<modelRoot>/<org>/<name>（transformers.js 的 localModelPath 约定）。 */
export function modelPath(modelRoot, model = EMBEDDING_MODEL) {
  return join(modelRoot, ...model.id.split('/'));
}

/** 只按大小快速判断是否装好（sha256 在安装时校验过）；任何文件缺失或大小不符都当未安装。 */
export function isModelInstalled(modelRoot, model = EMBEDDING_MODEL) {
  if (!modelRoot) return false;
  const dir = modelPath(modelRoot, model);
  return model.files.every(file => {
    const path = join(dir, file.path);
    return existsSync(path) && statSync(path).size === file.size;
  });
}
