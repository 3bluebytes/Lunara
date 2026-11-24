// embedding 子进程（add-local-semantic-memory-recall）。
// 由 EmbeddingClient fork；只从本地模型根加载（allowRemoteModels=false），不联网、不写缓存。
// 协议：父进程发 {id, texts}，回 {id, dims, data}（Float32Array，advanced 序列化）或 {id, error}。
// 错误只回错误码，不回文本内容；父进程断开时退出。
import { EMBEDDING_MODEL } from './embeddingModel.js';

const modelRoot = process.env.LUNARA_EMBEDDING_MODEL_ROOT;
let extractorPromise = null;

async function loadExtractor() {
  const transformers = await import('@huggingface/transformers');
  transformers.env.allowRemoteModels = false;
  transformers.env.allowLocalModels = true;
  transformers.env.localModelPath = modelRoot;
  transformers.env.useBrowserCache = false;
  transformers.env.useFSCache = false;
  return transformers.pipeline('feature-extraction', EMBEDDING_MODEL.id, { dtype: EMBEDDING_MODEL.dtype });
}

function errorCode(error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') return 'EMBEDDING_PACKAGE_MISSING';
  return 'EMBEDDING_FAILED';
}

process.on('message', async message => {
  const { id, texts } = message || {};
  try {
    extractorPromise ||= loadExtractor();
    const extractor = await extractorPromise;
    const output = await extractor(texts, { pooling: EMBEDDING_MODEL.pooling, normalize: true });
    process.send({ id, dims: output.dims, data: output.data });
  } catch (error) {
    process.send({ id, error: errorCode(error) });
  }
});

process.on('disconnect', () => process.exit(0));
process.send?.({ ready: true });
