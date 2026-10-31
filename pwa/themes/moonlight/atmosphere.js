// 氛围层：随主题 token 着色的星点场（缓慢漂移、闪烁、随音乐呼吸）。
import { mountParticleAtmosphere } from '../../visuals/particleField.js';

export function mount(container, context = {}) {
  return mountParticleAtmosphere(container, { ...context, motion: 'drift' });
}
