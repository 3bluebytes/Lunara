import express from 'express';
import { registerDefaultRoutes } from '../http/registerDefaultRoutes.js';
import { requireJsonForStateChange, requireLocalHost } from '../http/requestBoundary.js';

/**
 * Create an Express application without binding a port or starting background
 * work. Route registration is injected so this module remains a pure factory.
 */
export function createHttpApp(options = {}) {
  const runtime = options.runtime || null;
  const services = options.services || runtime?.services || {};
  const app = express();

  app.disable('x-powered-by');
  // Request-shape guards run before any body parsing or route work. They do not
  // authenticate: this process is a single-user loopback service, and the threat
  // they address is the user's own browser reaching loopback from other pages.
  app.use(requireLocalHost({ bindHost: options.bindHost }));
  app.use(requireJsonForStateChange());
  app.use(express.json({ limit: options.jsonLimit || '256kb' }));

  if (typeof options.configure === 'function') {
    options.configure({ app, runtime, services });
  }

  if (options.registerDefaultRoutes) {
    registerDefaultRoutes(app, services);
  }

  return app;
}
