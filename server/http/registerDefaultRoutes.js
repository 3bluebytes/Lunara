import { registerVirtualPersonRoutes } from './routes/virtualPersonRoutes.js';
import { registerAuthRoutes } from './routes/authRoutes.js';
import { registerRadiohostRoutes } from './routes/radiohostRoutes.js';
import { registerMemoryRoutes } from './routes/memoryRoutes.js';
import { registerOperationsRoutes } from './routes/operationsRoutes.js';
import { registerRadioRoutes } from './routes/radioRoutes.js';
import { registerSettingsRoutes } from './routes/settingsRoutes.js';
import { registerWebAccessRoutes } from './routes/webAccessRoutes.js';
import { registerLlmRoutes } from './routes/llmRoutes.js';
import { registerAdminRoutes } from './routes/adminRoutes.js';
import { registerRecordingReviewRoutes } from './routes/recordingReviewRoutes.js';
import { registerLifeContextRoutes } from './routes/lifeContextRoutes.js';
import { registerTrackLikeRoutes } from './routes/trackLikeRoutes.js';
import { registerMediaRelayRoutes } from './routes/mediaRelayRoutes.js';

export function registerDefaultRoutes(app, services) {
  registerVirtualPersonRoutes(app, services);
  registerAuthRoutes(app, services);
  registerRadioRoutes(app, services);
  registerOperationsRoutes(app, services);
  registerMemoryRoutes(app, services);
  registerRadiohostRoutes(app, services);
  registerSettingsRoutes(app, services);
  registerWebAccessRoutes(app, services);
  registerLlmRoutes(app, services);
  registerAdminRoutes(app, services);
  registerRecordingReviewRoutes(app, services);
  registerLifeContextRoutes(app, services);
  registerTrackLikeRoutes(app, services);
  registerMediaRelayRoutes(app, services);
  return app;
}
